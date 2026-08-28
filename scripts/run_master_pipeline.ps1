# run_master_pipeline.ps1 (Updated with Cloud Persistence Integration)

param(
    [Parameter(Mandatory=$true)]
    [string]$SessionId,

    [int]$TrackIndex = 1,

    [string]$GenreLock = "heavy_alternative_rock"
)

Write-Host "================================================================"
Write-Host "HYBRID 1.0 - MASTER PIPELINE EXECUTION"
Write-Host "Session ID: $SessionId"
Write-Host "Track Index: $TrackIndex"
Write-Host "Genre Lock: $GenreLock"
Write-Host "================================================================"

$WorkDir = "D:\MusicDatasets\renders\$SessionId"

# Step 1: AI Inference / Stem Generation (420 stems)
Write-Host "[PIPELINE] Running AI inference for 420 stems..."
python "D:\MusicDatasets\scripts\ai_inference_engine.py" --session "$SessionId" --genre "$GenreLock"
if ($LASTEXITCODE -ne 0) { throw "AI Inference failed." }

# Step 2: Sequential Bus Summation
Write-Host "[PIPELINE] Running sequential cylinder bus summation..."
python "D:\MusicDatasets\scripts\cylinder_bus_summation.py" --session "$SessionId" --dir "$WorkDir"
if ($LASTEXITCODE -ne 0) { throw "Bus summation failed." }

# Step 3: Cryptographic Hex Hook & Vault Lock
Write-Host "[PIPELINE] Locking master hash via cryptographic hex hook..."
python "D:\MusicDatasets\scripts\hybrid_hex_pipeline_hook.py" --session "$SessionId" --dir "$WorkDir"
if ($LASTEXITCODE -ne 0) { throw "Hex pipeline hook failed." }

# Step 4: Cloud Persistence Upload
Write-Host "[PIPELINE] Uploading master track to Supabase storage bucket..."
python "D:\MusicDatasets\scripts\upload_master_to_cloud.py" --session "$SessionId" --dir "$WorkDir"
if ($LASTEXITCODE -ne 0) { throw "Cloud upload failed." }

# Step 5: Post-Render Local Drive Purge
Write-Host "[PIPELINE] Purging temporary raw stems from local drive workspace..."
$RawStemsDir = Join-Path $WorkDir "raw_stems"
if (Test-Path $RawStemsDir) {
    Remove-Item -Recurse -Force $RawStemsDir
    Write-Host "  -> [CLEANUP] Temporary stems purged successfully. Master track secured in cloud and local vault."
}

Write-Host "================================================================"
Write-Host "[SUCCESS] Pipeline execution complete for Track Index $TrackIndex."
Write-Host "================================================================"
