# Direct end-to-end test: assemble from local 4.0s corpus, then master.
# Genre alt_rock, SliceDuration 4.0. Fails closed if the assembled wav is missing.
$ErrorActionPreference = "Stop"

$DataRoot = "D:\MusicDatasets"

$resolveCandidates = @(
    (Join-Path $PSScriptRoot "resolve_python.ps1"),
    (Join-Path $DataRoot "scripts\resolve_python.ps1")
)
$PythonExe = $null
foreach ($script in $resolveCandidates) {
    if (Test-Path $script) {
        . $script
        $PythonExe = Get-HybridPython -Quiet
        if ($PythonExe) { break }
    }
}

if (-not $PythonExe -or -not (Test-Path $PythonExe)) {
    Write-Host "[ERROR] No usable Python interpreter. Get-HybridPython failed." -ForegroundColor Red
    exit 1
}

$EnginePy = Join-Path $DataRoot "engine\local_track_synthesizer.py"
if (-not (Test-Path $EnginePy)) {
    $repoEngine = Join-Path (Split-Path $PSScriptRoot -Parent) "engine\local_track_synthesizer.py"
    if (Test-Path $repoEngine) {
        $EnginePy = $repoEngine
    }
}
if (-not (Test-Path $EnginePy)) {
    Write-Host "[ERROR] local_track_synthesizer.py not found." -ForegroundColor Red
    exit 1
}

$PipelinePs1 = Join-Path $DataRoot "scripts\run_master_pipeline.ps1"
if (-not (Test-Path $PipelinePs1)) {
    $PipelinePs1 = Join-Path $PSScriptRoot "run_master_pipeline.ps1"
}

$SessionId = "local_test_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
$ScratchMix = Join-Path $DataRoot "scratch\$SessionId\assembled_mix.wav"
$TargetGenre = "alt_rock"
$SliceDuration = 4.0

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 1. ASSEMBLING 3-MINUTE TRACK FROM LOCAL 4.0S CORPUS      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
& $PythonExe $EnginePy `
    --corpus (Join-Path $DataRoot "corpus_4s") `
    --out "$ScratchMix" `
    --duration 180.0

if (-not (Test-Path $ScratchMix)) {
    Write-Host "[ERROR] Local track assembly failed." -ForegroundColor Red
    exit 1
}
$mixInfo = Get-Item $ScratchMix
if ($mixInfo.Length -lt 1000) {
    Write-Host "[ERROR] Assembled wav is missing or truncated: $ScratchMix" -ForegroundColor Red
    exit 1
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 2. PIPING COMPOSITE INTO DSP MASTERING EXHAUST          " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
# run_master_pipeline.ps1 uses -GenreLock / -SliceSeconds (not -TargetGenre / -SliceDuration).
& powershell -ExecutionPolicy Bypass -File $PipelinePs1 `
    -SessionId "$SessionId" `
    -GenreLock $TargetGenre `
    -SliceSeconds $SliceDuration

Write-Host "==========================================================" -ForegroundColor Green
Write-Host " TEST RUN COMPLETE: Zero API credits used.               " -ForegroundColor Green
Write-Host " Deliverable: D:\MusicDatasets\releases\$SessionId        " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
