# D:\MusicDatasets\scripts\run_master_pipeline.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$SessionId,

    [Parameter(Mandatory=$true)]
    [string]$GenreLock,

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
    [switch]$NoDither = $false
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
$WorkDir = Join-Path $BaseDir "renders\$SessionId"
$RawStemsDir = Join-Path $WorkDir "raw_stems"
$ScriptsDir = Join-Path $BaseDir "scripts"
$SlicesDir = Join-Path "$BaseDir\uploaded_slices" $GenreLock
$TelemetryScript = Join-Path $ScriptsDir "log_telemetry.py"

function Send-Telemetry {
    param(
        [string]$EventType,
        [double]$Duration = 0,
        [string]$MetadataJson = "{}"
    )
    if (Test-Path $TelemetryScript) {
        python $TelemetryScript --event $EventType --user $UserId --session $SessionId --duration $Duration --metadata $MetadataJson
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

    if ((Test-Path $ResolverScript) -and -not (Test-Path (Join-Path "$BaseDir\uploaded_slices" $GenreLock))) {
        . "$ScriptsDir\resolve_python.ps1"
        $python = Get-HybridPython -Quiet

        if ($python) {
            $candidate = (& $python $ResolverScript --requested $GenreLock --slices-dir "$BaseDir\uploaded_slices" 2>$null | Select-Object -First 1)

            if ($candidate -and $candidate.Trim() -and $candidate.Trim() -ne $GenreLock) {
                $ResolvedGenre = $candidate.Trim()
                Write-Host "[GENRE] '$GenreLock' has no staged slices; substituting nearest profile '$ResolvedGenre'." -ForegroundColor Yellow
                Send-Telemetry -EventType "genre_substituted" -Duration 0 -MetadataJson "{`"requested`":`"$GenreLock`",`"resolved`":`"$ResolvedGenre`"}"
                $SlicesDir = Join-Path "$BaseDir\uploaded_slices" $ResolvedGenre
            }
        }
    }

    # 2. Stage slices as raw stems for summation
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Staging 1000ms audio slices from $SlicesDir..."

    if (Test-Path $SlicesDir) {
        $SliceFiles = Get-ChildItem -Path $SlicesDir -Filter "*.wav" | Select-Object -First $RequiredSlices

        if ($SliceFiles.Count -eq 0) {
            throw "No audio slices found in $SlicesDir. Run ingestion first."
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
        throw "Genre slice directory not found: $SlicesDir"
    }

    # 3. Execute AI Inference / Stem Conditioning
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Running AI inference and stem conditioning engine..."
    $InferenceScript = Join-Path $ScriptsDir "ai_inference_engine.py"

    if (Test-Path $InferenceScript) {
        python $InferenceScript --session $SessionId --dir $WorkDir --genre $ResolvedGenre
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

            python @premixArgs
            if ($LASTEXITCODE -ne 0) { throw "Cylinder premix failed." }
            $StepTimer.Stop()
            Send-Telemetry -EventType "premix_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2)) -MetadataJson "{`"layers`":$PremixLayers,`"positions`":$DurationSeconds}"
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
    python $SummationScript --session $SessionId --dir $WorkDir
    $StepTimer.Stop()
    Send-Telemetry -EventType "summation_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))

    # 5. Execute Cryptographic Hex Hashing & Vault Lock
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Executing Cryptographic Hex Hashing & Vault Lock..."
    $HexScript = Join-Path $ScriptsDir "hybrid_hex_pipeline_hook.py"
    python $HexScript --session $SessionId --dir $WorkDir
    $StepTimer.Stop()
    Send-Telemetry -EventType "hashing_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))

    # 6. Execute Cloud Upload to Supabase Storage
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Uploading master render to Supabase cloud storage..."
    $UploadScript = Join-Path $ScriptsDir "upload_master_to_cloud.py"
    python $UploadScript --session $SessionId --dir $WorkDir
    $StepTimer.Stop()
    Send-Telemetry -EventType "upload_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2))

    # 7. Egress Protection - purge the 420 staged stems now that the master is
    #    hashed and safely in cloud storage. Runs only after upload succeeds, so
    #    a failed upload leaves the stems recoverable for a re-run.
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Purging local raw stems to reclaim D: capacity..."
    $EgressScript = Join-Path $ScriptsDir "egress_protection.py"

    if (Test-Path $EgressScript) {
        python $EgressScript --session $SessionId --dir (Join-Path $BaseDir "renders")
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
