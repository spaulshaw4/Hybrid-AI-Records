param(
    [Parameter(Mandatory = $true)]
    [string]$Prompt,

    [Parameter(Mandatory = $false)]
    [string]$GenreOverride = "alt_rock",

    [Parameter(Mandatory = $false)]
    [double]$Duration = 180.0
)

$ErrorActionPreference = "Stop"
$BaseDir = "D:\MusicDatasets"
$RepoScripts = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path $RepoScripts -Parent
$WorkScripts = $RepoScripts
if (Test-Path (Join-Path $BaseDir "scripts\arrange_from_prompt.py")) {
    $WorkScripts = Join-Path $BaseDir "scripts"
}

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    Get-Content -Path $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or $line -notmatch "=") { return }
        $parts = $line.Split("=", 2)
        $key = $parts[0].Trim()
        $value = $parts[1].Trim().Trim('"').Trim("'")
        if ($key -and $value -and -not (Get-Item "env:$key" -ErrorAction SilentlyContinue)) {
            Set-Item -Path "env:$key" -Value $value
        }
    }
}

Import-DotEnv (Join-Path $RepoRoot ".env.local")
Import-DotEnv (Join-Path $RepoRoot ".env")
Import-DotEnv (Join-Path $BaseDir ".env.local")
Import-DotEnv (Join-Path $BaseDir ".env")

. (Join-Path $RepoScripts "resolve_python.ps1")
$PythonExe = $null
if ($env:HYBRID_PYTHON -and (Test-Path $env:HYBRID_PYTHON)) { $PythonExe = $env:HYBRID_PYTHON }
if (-not $PythonExe) { $PythonExe = Get-HybridPython -Quiet }
if (-not $PythonExe) { throw "No usable Python interpreter found." }

if (-not $env:REPLICATE_API_TOKEN -and $env:LYRIC_ENGINE_API_KEY) {
    $env:REPLICATE_API_TOKEN = $env:LYRIC_ENGINE_API_KEY
}
if (-not $env:REPLICATE_API_TOKEN) {
    throw "REPLICATE_API_TOKEN is not set. Load it from .env before running."
}

$SessionId = "prompt_" + (Get-Date -Format "yyyyMMdd_HHmmss")
$ScratchDir = Join-Path $BaseDir ("scratch\" + $SessionId)
$ReleaseDir = Join-Path $BaseDir ("releases\" + $SessionId)
$ArrangementJson = Join-Path $ScratchDir "arrangement.json"
$AssembledWav = Join-Path $ScratchDir "assembled_mix.wav"
$MasterWav = Join-Path $ReleaseDir "master_output.wav"
$LedgerDb = Join-Path $BaseDir "config\master_ledger.db"
$Corpus = Join-Path $BaseDir "corpus_4s"
$FallbackCorpus = Join-Path $BaseDir "uploaded_slices\dsd100_4s"

New-Item -ItemType Directory -Force -Path $ScratchDir | Out-Null
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null

$corpusCount = @(Get-ChildItem -Path $Corpus -Filter "*.wav" -Recurse -ErrorAction SilentlyContinue).Count
if ($corpusCount -lt 8 -and (Test-Path $FallbackCorpus)) {
    Write-Host "[CORPUS] corpus_4s has $corpusCount files; using fallback 4.0s pool" -ForegroundColor Yellow
    $Corpus = $FallbackCorpus
}

$ArrangeScript = Join-Path $RepoScripts "arrange_from_prompt.py"
$SynthScript = Join-Path $RepoRoot "engine\local_track_synthesizer.py"
$MasterScript = Join-Path $BaseDir "scripts\studio_master_chain.py"
$QcScript = Join-Path $RepoScripts "audio_qc_analyzer.py"
$LedgerScript = Join-Path $RepoScripts "sync_master_ledger.py"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host (" HYBRID LIVE PROMPT PIPELINE  " + $SessionId) -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host (" Prompt : " + $Prompt)
Write-Host (" Genre  : " + $GenreOverride)
Write-Host (" Corpus : " + $Corpus)

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 1. GEMINI ON REPLICATE - SECTION BREAKDOWN" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
& $PythonExe $ArrangeScript --prompt $Prompt --genre $GenreOverride --duration $Duration --out $ArrangementJson
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ArrangementJson)) {
    throw "Step 1 failed: Gemini arrangement was not written."
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 2. LOCAL ASSEMBLY FROM 4.0S CORPUS" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
& $PythonExe $SynthScript --corpus $Corpus --out $AssembledWav --duration $Duration --arrangement $ArrangementJson --max-slices 64
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $AssembledWav)) {
    throw "Step 2 failed: assembled mix missing."
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 3. DSP MASTERING EXHAUST + LEDGER" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
& $PythonExe $MasterScript --input $AssembledWav --output $MasterWav --genre $GenreOverride --bit-depth 24 --ceiling -0.5
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $MasterWav)) {
    throw "Step 3 failed: master was not written."
}

& $PythonExe $QcScript --wav-path $MasterWav --genre $GenreOverride
$QcReport = Join-Path $ReleaseDir "master_output_qc_report.json"

$TruePeak = -0.50
$Phase = 0.80
if (Test-Path $QcReport) {
    $qc = Get-Content $QcReport -Raw | ConvertFrom-Json
    if ($qc.metrics.true_peak_dbtp) { $TruePeak = [double]$qc.metrics.true_peak_dbtp }
    if ($qc.metrics.stereo_phase_correlation) { $Phase = [double]$qc.metrics.stereo_phase_correlation }
}

$Sha256 = (Get-FileHash -Path $MasterWav -Algorithm SHA256).Hash.ToLower()
$S3Key = $SessionId + "/master_output.wav"
& $PythonExe $LedgerScript --db $LedgerDb --session-id $SessionId --genre $GenreOverride --s3-key $S3Key --sha256 $Sha256 --true-peak $TruePeak --phase $Phase --verify-path $MasterWav
if ($LASTEXITCODE -ne 0) {
    throw "Ledger sync failed."
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " TRACK READY" -ForegroundColor Green
Write-Host (" Deliverable: " + $MasterWav) -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
