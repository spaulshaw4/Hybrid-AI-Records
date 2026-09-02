<#
.SYNOPSIS
    After corpus_4s_bulk finishes, extract fma_large.zip only.
.DESCRIPTION
    Waits until the live slicing campaign process is gone and the ledger has
    no PENDING/IN_PROGRESS rows. Then integrity-tests fma_large.zip with tar
    and extracts into D:\MusicDatasets\fma\fma_large.

    Never extracts fma_full.zip. Never slices corpus_4s. Never deletes the zip.
    Does not replace run_master_pipeline.ps1.
#>
param(
    [string]$ZipPath = "D:\MusicDatasets\fma\fma_large.zip",
    [string]$DestDir = "D:\MusicDatasets\fma\fma_large",
    [string]$Database = "D:\MusicDatasets\db\corpus_index.sqlite",
    [string]$LogDir = "D:\MusicDatasets\logs",
    [string]$PythonExe = "C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe",
    [int]$PollSec = 60,
    [int]$MinFreeGB = 80,
    [long]$ExpectedBytes = 100306112191
)

$ErrorActionPreference = "Stop"
$tarExe = (Get-Command tar -ErrorAction SilentlyContinue).Source
if (-not $tarExe) { throw "tar.exe not found" }
if (-not (Test-Path $PythonExe)) { throw "Python 3.12 not found at $PythonExe" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
$log = Join-Path $LogDir ("next_job_fma_large_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))

function Write-JobLog([string]$Message) {
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-SlicerPids {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -match "run_slicing_campaign\.py"
    } | ForEach-Object { $_.ProcessId })
}

function Get-CampaignRemaining {
    $probe = Join-Path $env:TEMP "fma_large_campaign_remaining.py"
    @"
import sqlite3
uri = "file:D:/MusicDatasets/db/corpus_index.sqlite?mode=ro"
conn = sqlite3.connect(uri, uri=True, timeout=8)
conn.execute("PRAGMA busy_timeout=8000")
n = conn.execute(
    "SELECT COUNT(*) FROM campaign_files WHERE campaign='corpus_4s_bulk' AND status IN ('PENDING','IN_PROGRESS')"
).fetchone()[0]
print(n)
conn.close()
"@ | Set-Content -LiteralPath $probe -Encoding ASCII
    & $PythonExe $probe
}

function Get-FreeGB {
    $drive = Get-PSDrive -Name (Split-Path -Qualifier $DestDir).TrimEnd(":")
    return [math]::Round($drive.Free / 1GB, 1)
}

Write-JobLog "queued fma_large extract after corpus_4s_bulk"
Write-JobLog "zip=$ZipPath dest=$DestDir log=$log"
if (-not (Test-Path -LiteralPath $ZipPath)) { throw "missing $ZipPath" }
$zipName = [IO.Path]::GetFileName($ZipPath)
if ($zipName -like "fma_full*") { throw "refusing fma_full" }

while ($true) {
    $pids = Get-SlicerPids
    $remaining = 0
    try { $remaining = [int](Get-CampaignRemaining) } catch { Write-JobLog "ledger busy: $_" ; Start-Sleep $PollSec ; continue }
    if ($pids.Count -eq 0 -and $remaining -le 0) {
        $have = (Get-Item -LiteralPath $ZipPath).Length
        if ($ExpectedBytes -gt 0 -and $have -lt $ExpectedBytes) {
            Write-JobLog ("waiting zip {0:N2} / {1:N2} GB" -f ($have/1GB), ($ExpectedBytes/1GB))
            Start-Sleep -Seconds $PollSec
            continue
        }
        break
    }
    Write-JobLog ("waiting slicer_pids={0} remaining_files={1} free_gb={2}" -f ($pids -join ","), $remaining, (Get-FreeGB))
    Start-Sleep -Seconds $PollSec
}

Write-JobLog "campaign settled; testing archive"
$marker = "$DestDir.extracted"
if (Test-Path $marker) {
    Write-JobLog "already extracted (marker present); exit"
    exit 0
}

$free = Get-FreeGB
$sizeGb = [math]::Round((Get-Item -LiteralPath $ZipPath).Length / 1GB, 2)
if (($free - $sizeGb) -lt $MinFreeGB) {
    Write-JobLog ("ABORT free={0} GB zip={1} GB min_free={2}" -f $free, $sizeGb, $MinFreeGB)
    exit 2
}

Write-JobLog "tar -tf (integrity)"
& $tarExe -tf $ZipPath 1>$null
if ($LASTEXITCODE -ne 0) {
    Write-JobLog "ABORT zip failed tar -tf (truncated or corrupt). Resume download; do not extract."
    exit 3
}

Write-JobLog ("EXTRACT {0} GB -> {1}" -f $sizeGb, $DestDir)
$sw = [Diagnostics.Stopwatch]::StartNew()
& $tarExe -xf $ZipPath -C $DestDir
$code = $LASTEXITCODE
$sw.Stop()
if ($code -ne 0) {
    Write-JobLog ("EXTRACT failed exit={0} after {1} min" -f $code, [math]::Round($sw.Elapsed.TotalMinutes, 1))
    exit $code
}

@(
    "source=$ZipPath"
    "source_bytes=$((Get-Item -LiteralPath $ZipPath).Length)"
    "extracted_utc=$((Get-Date).ToUniversalTime().ToString('o'))"
    "duration_sec=$([math]::Round($sw.Elapsed.TotalSeconds,1))"
) | Set-Content -Path $marker -Encoding UTF8
Write-JobLog ("done in {0} min free_gb={1}" -f [math]::Round($sw.Elapsed.TotalMinutes, 1), (Get-FreeGB))
exit 0
