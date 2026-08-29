# D:\MusicDatasets\scripts\run_master_pipeline.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$SessionId,

    [Parameter(Mandatory=$true)]
    [string]$GenreLock,

    [Parameter(Mandatory=$false)]
    [string]$UserId = "00000000-0000-0000-0000-000000000001"
)

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

    # 2. Stage slices as raw stems for summation
    $StepTimer.Restart()
    Write-Host "[PIPELINE] Staging 1000ms audio slices from $SlicesDir..."

    if (Test-Path $SlicesDir) {
        $SliceFiles = Get-ChildItem -Path $SlicesDir -Filter "*.wav" | Select-Object -First 420

        if ($SliceFiles.Count -eq 0) {
            throw "No audio slices found in $SlicesDir. Run ingestion first."
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
        python $InferenceScript --session $SessionId --dir $WorkDir --genre $GenreLock
        $StepTimer.Stop()
        Send-Telemetry -EventType "inference_completed" -Duration ([math]::Round($StepTimer.Elapsed.TotalSeconds, 2)) -MetadataJson "{`"genre`":`"$GenreLock`"}"
    } else {
        Write-Host "  -> [INFO] ai_inference_engine.py not found. Proceeding with staged raw stems."
    }

    # 4. Execute Cylinder Bus Summation
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

    # 7. Pipeline Completion
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
