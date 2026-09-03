param (
    [Parameter(Mandatory = $true)]
    [Alias("GenreLock")]
    [string]$TargetGenre,

    [Parameter(Mandatory = $true)]
    [string]$SessionId,

    [double]$SliceDuration = 4.0,
    [switch]$NoStudioChain
)

$ErrorActionPreference = "Stop"
$BaseDir = "D:\MusicDatasets"
$RepoScripts = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $RepoScripts "resolve_python.ps1")
$PythonExe = Get-HybridPython -Quiet
if (-not $PythonExe) { throw "No usable Python interpreter found." }

$WorkDir = Join-Path $BaseDir "scratch\$SessionId"
$ReleaseDir = Join-Path $BaseDir "releases\$SessionId"
$DbPath = Join-Path $BaseDir "database\master_catalog.db"
$MasterOut = Join-Path $WorkDir "master_output.wav"
$BackupPreMaster = Join-Path $WorkDir "pre_master_backup.wav"
$Stager = Join-Path $RepoScripts "generic_slice_stager.py"
$Studio = Join-Path $BaseDir "scripts\studio_master_chain.py"
$QcGate = Join-Path $RepoScripts "qc_master_gate.py"
$S3Sync = Join-Path $RepoScripts "s3_storage_lifecycle.py"
$Ledger = Join-Path $RepoScripts "sync_master_ledger.py"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " STARTING MASTER PIPELINE: $SessionId ($TargetGenre)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

try {
    if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
    New-Item -ItemType Directory -Path $WorkDir | Out-Null
    New-Item -ItemType Directory -Path (Split-Path $DbPath) -Force | Out-Null
    New-Item -ItemType Directory -Path $ReleaseDir -Force | Out-Null

    Write-Host "[STAGE 1/6] Running Staging & Summation..." -ForegroundColor Yellow
    & $PythonExe $Stager --session-id $SessionId --slice-duration $SliceDuration --output-dir $WorkDir --genre $TargetGenre
    if (-not (Test-Path $MasterOut)) {
        throw "Summation failed: master_output.wav was not generated."
    }

    if (-not $NoStudioChain) {
        Write-Host "[STAGE 2/6] Executing Inline Studio DSP Pass..." -ForegroundColor Yellow
        Copy-Item $MasterOut $BackupPreMaster -Force
        & $PythonExe $Studio -i $BackupPreMaster -o $MasterOut --genre $TargetGenre --bit-depth 24 --ceiling -0.5
        if ($LASTEXITCODE -ne 0) {
            Copy-Item $BackupPreMaster $MasterOut -Force
            throw "Studio DSP chain failed. Rolled back to pre-master."
        }
    }

    Write-Host "[STAGE 3/6] Running Post-Master QC Gate..." -ForegroundColor Yellow
    $qcRaw = & $PythonExe $QcGate -i $MasterOut
    if ($LASTEXITCODE -ne 0) { throw "QC gate failed to measure the master." }
    $qcJson = $qcRaw | ConvertFrom-Json
    $truePeak = [double]$qcJson.true_peak_dbtp
    $phase = [double]$qcJson.phase_correlation
    Write-Host "  -> Measured True Peak: $truePeak dBTP (Limit: -0.50 dBTP)" -ForegroundColor Cyan
    Write-Host "  -> Phase Correlation:  $phase (Min: 0.80)" -ForegroundColor Cyan
    if ($truePeak -gt -0.50) {
        throw "QC VIOLATION: True peak ($truePeak dBTP) exceeds the -0.50 dBTP ceiling."
    }

    Write-Host "[STAGE 4/6] Uploading Master to vault-storage..." -ForegroundColor Yellow
    $sha256 = (Get-FileHash -Path $MasterOut -Algorithm SHA256).Hash.ToLower()
    Copy-Item $MasterOut (Join-Path $ReleaseDir "master_output.wav") -Force
    try {
        & $PythonExe $S3Sync --work-dir $WorkDir --session-id $SessionId --bucket "vault-storage"
    } catch {
        Write-Host "  -> [WARN] S3 lifecycle failed; local release retained: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Write-Host "[STAGE 5/6] Promoting to Streaming Catalog..." -ForegroundColor Yellow
    $ledgerMaster = Join-Path $ReleaseDir "master_output.wav"
    & $PythonExe $Ledger --db $DbPath --session-id $SessionId --genre $TargetGenre --s3-key "masters/$SessionId/master_output.wav" --sha256 $sha256 --true-peak $truePeak --phase $phase --verify-path $ledgerMaster
    if ($LASTEXITCODE -ne 0) { throw "Ledger promotion failed." }

    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host " [SUCCESS] PIPELINE COMPLETE: $SessionId MASTERED & LIVE" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
} catch {
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host " [FATAL ERROR] Pipeline aborted: $_" -ForegroundColor Red
    Write-Host "==========================================================" -ForegroundColor Red
    if (Test-Path $WorkDir) {
        $QuarantineDir = Join-Path $BaseDir "quarantine\$SessionId"
        New-Item -ItemType Directory -Path (Split-Path $QuarantineDir) -Force | Out-Null
        Move-Item -Path $WorkDir -Destination $QuarantineDir -Force -ErrorAction SilentlyContinue
        Write-Host "  -> Workspace quarantined at: $QuarantineDir" -ForegroundColor DarkGray
    }
    exit 1
}
