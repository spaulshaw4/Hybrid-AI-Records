# D:\MusicDatasets\scripts\run_master_pipeline.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$SessionId,

    [Parameter(Mandatory=$true)]
    [Alias("TargetGenre")]
    [string]$GenreLock,

    # Slice length used by the 4.0s corpus assembler. Does not replace
    # DurationSeconds (full track length).
    [Parameter(Mandatory=$false)]
    [double]$SliceDuration = 1.0,

    [Parameter(Mandatory=$false)]
    [string]$UserId = "00000000-0000-0000-0000-000000000001",

    # Master length in seconds. One 1000ms slice per timeline position, so this
    # equals the final track duration. Clamped to the supported range below.
    [Parameter(Mandatory=$false)]
    [int]$DurationSeconds = 420,

    # Stems overlaid simultaneously at each position by cylinder_premix_overlay.
    # 1 disables the premix stage and concatenates raw slices directly.
    [Parameter(Mandatory=$false)]
    [int]$PremixLayers = 4,

    # DSP calibration, applied to both the premix overlay and the final master.
    [Parameter(Mandatory=$false)]
    [double]$ThresholdDbfs = -3.0,

    [Parameter(Mandatory=$false)]
    [double]$CeilingDbfs = -0.5,

    [Parameter(Mandatory=$false)]
    [ValidateSet("acoustic", "linear", "unity")]
    [string]$GainMode = "acoustic",

    [Parameter(Mandatory=$false)]
    [ValidateSet(16, 24)]
    [int]$BitDepth = 16,

    [Parameter(Mandatory=$false)]
    [switch]$NoDither = $false,

    # Route each premix position through the 4-Quadrant matrix (Q1 low-end
    # foundation, Q2 harmonic mid-body, Q3 top-end) instead of a flat overlay.
    # Genre selects the quadrant profile; unlisted genres fall back by family.
    [Parameter(Mandatory=$false)]
    [switch]$UseQuadrant = $false,

    # Bypass the QC compliance gate. A failing master then uploads anyway, which
    # is occasionally wanted when iterating on DSP settings.
    [Parameter(Mandatory=$false)]
    [switch]$SkipQcGate = $false
)

# Invariant culture so a comma decimal separator never reaches argparse
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$ThresholdArg = $ThresholdDbfs.ToString($inv)
$CeilingArg = $CeilingDbfs.ToString($inv)

# Supported track length: 2:30 minimum, 7:00 maximum.
$MIN_DURATION_SEC = 150
$MAX_DURATION_SEC = 420

if ($DurationSeconds -lt $MIN_DURATION_SEC) {
    Write-Host "[DURATION] $DurationSeconds s is below the $MIN_DURATION_SEC s minimum; clamping." -ForegroundColor Yellow
    $DurationSeconds = $MIN_DURATION_SEC
} elseif ($DurationSeconds -gt $MAX_DURATION_SEC) {
    Write-Host "[DURATION] $DurationSeconds s exceeds the $MAX_DURATION_SEC s maximum; clamping." -ForegroundColor Yellow
    $DurationSeconds = $MAX_DURATION_SEC
}

if ($PremixLayers -lt 1) { $PremixLayers = 1 }

# Premix consumes layers x positions slices and emits `positions` composites,
# so staging must cover the vertical dimension too.
$RequiredSlices = $DurationSeconds * $PremixLayers

$ErrorActionPreference = "Stop"

$BaseDir = "D:\MusicDatasets"
$LiveRoot = if ($env:HYBRID_LIVE_OUTPUT) { $env:HYBRID_LIVE_OUTPUT } else { "C:\live_web_outputs" }
$WorkDir = Join-Path $LiveRoot "renders\$SessionId"
$RawStemsDir = Join-Path $WorkDir "raw_stems"
$ScriptsDir = Join-Path $BaseDir "scripts"
$SlicesDir = Join-Path "$BaseDir\uploaded_slices" $GenreLock
$TelemetryScript = Join-Path $ScriptsDir "log_telemetry.py"
Write-Host "[LIVE_IO] writes=$LiveRoot (not C:\staging_slices)"

# Resolve a real interpreter once, at script scope, before anything invokes it.
#
# Bare `python` on this machine resolves to the WindowsApps App Execution Alias,
# which prints "Python was not found" to stderr and exits 0. Every Python stage
# therefore appeared to succeed while doing nothing: no premix, no summation, no
# master, no upload - and the pipeline still reported success because the stub
# returns a zero exit code.
. "$ScriptsDir\resolve_python.ps1"
$script:Python = Get-HybridPython -Quiet

if (-not $script:Python) {
    Write-Host "[FATAL] No usable Python interpreter found." -ForegroundColor Red
    Write-Host "        resolve_python.ps1 rejects the WindowsApps alias stub; install" -ForegroundColor Yellow
    Write-Host "        Python from python.org or fix PATH before running the pipeline." -ForegroundColor Yellow
    exit 1
}

Write-Host "[PIPELINE] Interpreter: $script:Python"

function Send-Telemetry {
    param(
        [string]$EventType,
        [double]$Duration = 0,
        [string]$MetadataJson = "{}"
    )
    if (Test-Path $TelemetryScript) {
        & $script:Python $TelemetryScript --event $EventType --user $UserId --session $SessionId --duration $Duration --metadata $MetadataJson
    }
}

$TotalTimer = [System.Diagnostics.Stopwatch]::StartNew()
$StepTimer = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host "================================================================"
Write-Host "HYBRID 1.0 - MASTER PIPELINE ORCHESTRATOR"
Write-Host "Session ID: $SessionId | Genre: $GenreLock"
Write-Host "================================================================"

try {
    # 0. Pipeline Initiation Telemetry
    Send-Telemetry -EventType "pipeline_started" -Duration 0 -MetadataJson "{`"genre_lock`":`"$GenreLock`"}"

    # 1. Initialize working directories
    if (!(Test-Path $WorkDir)) { New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null }
    if (!(Test-Path $RawStemsDir)) { New-Item -ItemType Directory -Force -Path $RawStemsDir | Out-Null }

    # 1b. Resolve the requested genre to one that actually has slices.
    #     heavy_alternative_rock, nu_metal, rap_rock and amapiano match no label
    #     in either source dataset, so without this they abort every render.
    $ResolverScript = Join-Path $ScriptsDir "genre_resolver.py"
    $ResolvedGenre = $GenreLock

    $ScratchMix = Join-Path $LiveRoot "scratch\$SessionId\unmastered_mix.wav"
    if (-not (Test-Path $ScratchMix)) {
        $LegacyMix = Join-Path $BaseDir "scratch\$SessionId\unmastered_mix.wav"
        if (Test-Path $LegacyMix) { $ScratchMix = $LegacyMix }
    }
    $Preassembled = Test-Path $ScratchMix
    if ($Preassembled) {
        $MixBytes = (Get-Item $ScratchMix).Length
        Write-Host "[HANDOFF] generation -> composition mix_bytes=$MixBytes path=$ScratchMix"
        if ($MixBytes -lt 4096) {
            throw "Composition has nothing to give: $ScratchMix is $MixBytes bytes (ghost mix)."
        }
        Write-Host "[PIPELINE] Pre-assembled mix detected at $ScratchMix (slice $($SliceDuration.ToString($inv))s). Skipping restage." -ForegroundColor Cyan
    } else {
        Write-Host "[HANDOFF] no preassembled mix; composition would fall through to $SlicesDir"
    }

    if ((Test-Path $ResolverScript) -and -not $Preassembled -and -not (Test-Path (Join-Path "$BaseDir\uploaded_slices" $GenreLock))) {
        # Interpreter already resolved at script scope above
        if ($script:Python) {
            $candidate = (& $script:Python $ResolverScript --requested $GenreLock --slices-dir "$BaseDir\uploaded_slices" 2>$null | Select-Object -First 1)

            if ($candidate -and $candidate.Trim() -and $candidate.Trim() -ne $GenreLock) {
                $ResolvedGenre = $candidate.Trim()
                Write-Host "[GENRE] '$GenreLock' has no staged slices; substituting nearest profile '$ResolvedGenre'." -ForegroundColor Yellow
                Send-Telemetry -EventType "genre_substituted" -Duration 0 -MetadataJson "{`"requested`":`"$GenreLock`",`"resolved`":`"$ResolvedGenre`"}"
                $SlicesDir = Join-Path "$BaseDir\uploaded_slices" $ResolvedGenre
            }
        }
    }

    if ($Preassembled) {
        $StudioScript = Join-Path $ScriptsDir "studio_master_chain.py"
        $MasterWav = Join-Path $WorkDir "master_output.wav"
        $ReleaseDir = Join-Path $LiveRoot "releases\$SessionId"
        if (!(Test-Path $ReleaseDir)) { New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null }

        $StepTimer.Restart()
        Write-Host "[PIPELINE] Mastering pre-assembled mix through studio DSP chain..."
        if (-not (Test-Path $StudioScript)) { throw "studio_master_chain.py not found at $StudioScript" }
        & $script:Python $StudioScript --input $ScratchMix --output $MasterWav --genre $ResolvedGenre --bit-depth 24 --ceiling -0.5
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $MasterWav)) {
            throw "Studio master chain failed for pre-assembled mix."
        }
        Copy-Item -Path $MasterWav -Destination (Join-Path $ReleaseDir "master_output.wav") -Force
        $StepTimer.Stop()
        Send-Telemetry -EventType "summation_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2)) -MetadataJson "{`"preassembled`":true,`"slice_duration`":$SliceDuration}"
    } else {
    # 2. Stage slices as raw stems for summation
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Staging 1000ms audio slices from $SlicesDir..."

    if (Test-Path $SlicesDir) {
        $SliceFiles = Get-ChildItem -Path $SlicesDir -Filter "*.wav" | Select-Object -First $RequiredSlices

        if ($SliceFiles.Count -eq 0) {
            throw "Composition ghost folder: no audio slices in $SlicesDir. Generation must write scratch\$SessionId\unmastered_mix.wav first."
        }

        # Not enough material for the requested length: shorten rather than fail,
        # but never below the 2:30 floor.
        if ($SliceFiles.Count -lt $RequiredSlices) {
            $achievable = [math]::Floor($SliceFiles.Count / $PremixLayers)

            if ($achievable -lt $MIN_DURATION_SEC) {
                throw "Only $($SliceFiles.Count) slices in $SlicesDir. At $PremixLayers layers that yields ${achievable}s, under the ${MIN_DURATION_SEC}s minimum."
            }

            Write-Host "[DURATION] Only $($SliceFiles.Count) slices available; reducing target from ${DurationSeconds}s to ${achievable}s." -ForegroundColor Yellow
            $DurationSeconds = $achievable
            $RequiredSlices = $DurationSeconds * $PremixLayers
        }

        foreach ($file in $SliceFiles) {
            Copy-Item -Path $file.FullName -Destination $RawStemsDir
        }

        $StepTimer.Stop()
        $stagedCount = $SliceFiles.Count
        Write-Host "  -> Staged $stagedCount slices into raw_stems container ($([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))s)."
        Send-Telemetry -EventType "staging_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2)) -MetadataJson "{`"stems_staged`":$stagedCount}"
    } else {
        throw "Composition ghost folder not found: $SlicesDir. Generation must write scratch\$SessionId\unmastered_mix.wav first."
    }

    # 3. Execute AI Inference / Stem Conditioning
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Running AI inference and stem conditioning engine..."
    $InferenceScript = Join-Path $ScriptsDir "ai_inference_engine.py"

    if (Test-Path $InferenceScript) {
        & $script:Python $InferenceScript --session $SessionId --dir $WorkDir --genre $ResolvedGenre
        $StepTimer.Stop()
        Send-Telemetry -EventType "inference_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2)) -MetadataJson "{`"genre`":`"$GenreLock`"}"
    } else {
        Write-Host "  -> [INFO] ai_inference_engine.py not found. Proceeding with staged raw stems."
    }

    # 3b. Cylinder Premix - VERTICAL overlay. Consumes $PremixLayers slices per
    #     position and emits one composite per position, so the concatenated
    #     length below stays at $DurationSeconds.
    if ($PremixLayers -gt 1) {
        $StepTimer.Restart()
        Write-Host "[PIPELINE] Executing Cylinder Premix ($PremixLayers layers x $DurationSeconds positions)..."
        $PremixScript = Join-Path $ScriptsDir "cylinder_premix_overlay.py"

        if (Test-Path $PremixScript) {
            $premixArgs = @(
                $PremixScript,
                "--session", $SessionId,
                "--dir", $WorkDir,
                "--layers", $PremixLayers,
                "--positions", $DurationSeconds,
                "--gain-mode", $GainMode,
                "--threshold-dbfs", $ThresholdArg,
                "--ceiling-dbfs", $CeilingArg,
                "--bit-depth", $BitDepth
            )
            if ($NoDither) { $premixArgs += "--no-dither" }
            if ($UseQuadrant) { $premixArgs += @("--quadrant", "--genre", $ResolvedGenre) }

            & $script:Python @premixArgs
            if ($LASTEXITCODE -ne 0) { throw "Cylinder premix failed." }
            $StepTimer.Stop()
            Send-Telemetry -EventType "premix_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2)) -MetadataJson "{`"layers`":$PremixLayers,`"positions`":$DurationSeconds,`"quadrant`":$($UseQuadrant.ToString().ToLower())}"
        } else {
            Write-Host "  -> [INFO] cylinder_premix_overlay.py not found; concatenating raw slices." -ForegroundColor Yellow
        }
    } else {
        Write-Host "[PIPELINE] Premix disabled (PremixLayers=1); concatenating raw slices."
    }

    # 4. Execute Cylinder Bus Summation - HORIZONTAL concatenation
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Executing Cylinder Bus Summation..."
    $SummationScript = Join-Path $ScriptsDir "cylinder_bus_summation.py"
    & $script:Python $SummationScript --session $SessionId --dir $WorkDir
    $StepTimer.Stop()
    Send-Telemetry -EventType "summation_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))
    }

    # 4b. QC Compliance Gate
    #     A master that fails true-peak, phase, or DC must not reach the Vault,
    #     and its scratch is deliberately NOT purged so the failure can be
    #     inspected. Loudness is measured but excluded from the gate: a quiet
    #     master is a mix outcome, whereas an overshoot or a phase-cancelling
    #     mix is a defect.
    $QcScript = Join-Path $ScriptsDir "audio_qc_analyzer.py"
    $MasterWav = Join-Path $WorkDir "master_output.wav"

    if ((Test-Path $QcScript) -and (Test-Path $MasterWav)) {
        $StepTimer.Restart()
        Write-Host "[PIPELINE] Running QC compliance audit..."

        # --apply-dc-block runs the spec's enforcement action before the verdict:
        # the master bus concatenates slices without a DC blocker, so accumulated
        # offset should be corrected rather than merely reported as a failure.
        & $script:Python $QcScript --wav-path $MasterWav --genre $ResolvedGenre --apply-dc-block
        $QcExit = $LASTEXITCODE
        $StepTimer.Stop()

        if ($QcExit -ne 0 -and -not $SkipQcGate) {
            Send-Telemetry -EventType "qc_failed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2)) -MetadataJson "{`"session_id`":`"$SessionId`",`"quarantined`":true}"
            Write-Host "  -> [QC FAIL] Master did not meet acceptance standards." -ForegroundColor Red
            Write-Host "  -> Scratch retained for inspection at $WorkDir" -ForegroundColor Yellow
            throw "QC compliance gate failed for session $SessionId. Upload aborted; scratch quarantined."
        }

        if ($QcExit -ne 0) {
            Write-Host "  -> [QC WARN] Gate bypassed via -SkipQcGate; proceeding despite failure." -ForegroundColor Yellow
        }

        Send-Telemetry -EventType "qc_passed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))
    } elseif (Test-Path $QcScript) {
        Write-Host "  -> [INFO] No master_output.wav to audit; skipping QC gate." -ForegroundColor Yellow
    }

    # 5. Execute Cryptographic Hex Hashing & Vault Lock
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Executing Cryptographic Hex Hashing & Vault Lock..."
    $HexScript = Join-Path $ScriptsDir "hybrid_hex_pipeline_hook.py"
    try {
        & $script:Python $HexScript --session $SessionId --dir $WorkDir
        if ($LASTEXITCODE -ne 0) { throw "hex hook exited $LASTEXITCODE" }
        $StepTimer.Stop()
        Send-Telemetry -EventType "hashing_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))
    } catch {
        if ($Preassembled) {
            Write-Host "  -> [WARN] Hex lock skipped (local preassembled master retained): $($_.Exception.Message)" -ForegroundColor Yellow
        } else {
            throw
        }
    }

    # 6. Execute Cloud Upload to Supabase Storage
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Uploading master render to Supabase cloud storage..."
    $UploadScript = Join-Path $ScriptsDir "upload_master_to_cloud.py"
    try {
        & $script:Python $UploadScript --session $SessionId --dir $WorkDir
        if ($LASTEXITCODE -ne 0) { throw "upload exited $LASTEXITCODE" }
        $StepTimer.Stop()
        Send-Telemetry -EventType "upload_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))
    } catch {
        if ($Preassembled) {
            Write-Host "  -> [WARN] Cloud upload skipped (local release already written): $($_.Exception.Message)" -ForegroundColor Yellow
        } else {
            throw
        }
    }

    # 7. Egress Protection - purge the 420 staged stems now that the master is
    #    hashed and safely in cloud storage. Runs only after upload succeeds, so
    #    a failed upload leaves the stems recoverable for a re-run.
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Purging local raw stems to reclaim D: capacity..."
    $EgressScript = Join-Path $ScriptsDir "egress_protection.py"

    if (Test-Path $EgressScript) {
        & $script:Python $EgressScript --session $SessionId --dir (Join-Path $LiveRoot "renders")
        $StepTimer.Stop()
        Send-Telemetry -EventType "stems_purged" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))
    } elseif (Test-Path $RawStemsDir) {
        Remove-Item -Recurse -Force $RawStemsDir
        $StepTimer.Stop()
        Write-Host "  -> Purged $RawStemsDir directly (egress_protection.py not found)."
        Send-Telemetry -EventType "stems_purged" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))
    } else {
        Write-Host "  -> [INFO] No raw_stems directory present. Nothing to purge."
    }

    # 8. Pipeline Completion
    $TotalTimer.Stop()
    $totalSec = [math]::Round($TotalTimer.Elapsed.TotalSeconds, 2)
    Write-Host "[SUCCESS] Master pipeline execution completed successfully for session $SessionId in ${totalSec}s."
    Send-Telemetry -EventType "pipeline_completed" -Duration $totalSec -MetadataJson "{`"status`":`"success`"}"

} catch {
    $TotalTimer.Stop()
    $failedSec = [math]::Round($TotalTimer.Elapsed.TotalSeconds, 2)
    $errorMessage = $_.Exception.Message.Replace('"', '\"').Replace("`n", " ")

    Write-Host "[FAILURE] Pipeline error encountered: $errorMessage" -ForegroundColor Red
    Send-Telemetry -EventType "pipeline_failed" -Duration $failedSec -MetadataJson "{`"error`":`"$errorMessage`"}"
    throw $_
}
