<#
.SYNOPSIS
    After corpus_4s_bulk finishes: extract fma_large, unzip leftover packs, rescan-slice.
.DESCRIPTION
    Waits for the live slicer to drain. Does not kill it.

    Then:
      1. Wait until fma_large.zip is the full 93.42 GB
      2. Extract fma_large.zip -> D:\MusicDatasets\fma\fma_large (never fma_full)
      3. Run unzip_eligible_zips.py --execute for any remaining sample packs
      4. Start run_slicing_campaign.ps1 -Execute -Workers 8 WITH scan

    Never extracts fma_full.zip. Never slices uploaded_slices or corpus_4s as --root.
#>
param(
    [string]$FmaLargeZip = "D:\MusicDatasets\fma\fma_large.zip",
    [string]$FmaLargeDest = "D:\MusicDatasets\fma\fma_large",
    [long]$FmaLargeExpected = 100306112191,
    [int]$PollSec = 60,
    [int]$MinFreeGB = 80,
    [string]$PythonExe = "C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe",
    [string]$LogDir = "D:\MusicDatasets\logs"
)

$ErrorActionPreference = "Stop"
$tarExe = (Get-Command tar -ErrorAction SilentlyContinue).Source
if (-not $tarExe) { throw "tar.exe not found" }
if (-not (Test-Path $PythonExe)) { throw "Python 3.12 not found at $PythonExe" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path $FmaLargeDest | Out-Null
$log = Join-Path $LogDir ("unzip_slice_remainder_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))
$Scripts = "D:\MusicDatasets\scripts"

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
    $probe = Join-Path $env:TEMP "remainder_campaign_remaining.py"
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
    [math]::Round((Get-PSDrive D).Free / 1GB, 1)
}

Write-JobLog "remainder: unzip leftovers + fma_large extract + rescan slice"
Write-JobLog "log=$log"

while ($true) {
    $pids = Get-SlicerPids
    $remaining = 0
    try { $remaining = [int](Get-CampaignRemaining) } catch { Write-JobLog "ledger busy: $_"; Start-Sleep $PollSec; continue }
    $have = 0
    if (Test-Path -LiteralPath $FmaLargeZip) { $have = (Get-Item -LiteralPath $FmaLargeZip).Length }
    if ($pids.Count -eq 0 -and $remaining -le 0 -and $have -ge $FmaLargeExpected) { break }
    Write-JobLog ("waiting slicer={0} remaining={1} fma_large_gb={2:N2}/{3:N2} free={4}" -f ($pids -join ","), $remaining, ($have/1GB), ($FmaLargeExpected/1GB), (Get-FreeGB))
    Start-Sleep -Seconds $PollSec
}

$marker = "$FmaLargeDest.extracted"
if (-not (Test-Path $marker)) {
    $free = Get-FreeGB
    $sizeGb = [math]::Round((Get-Item -LiteralPath $FmaLargeZip).Length / 1GB, 2)
    if (($free - $sizeGb) -lt $MinFreeGB) {
        Write-JobLog ("ABORT free={0} zip={1}" -f $free, $sizeGb)
        exit 2
    }
    Write-JobLog "tar -tf fma_large.zip"
    & $tarExe -tf $FmaLargeZip 1>$null
    if ($LASTEXITCODE -ne 0) {
        Write-JobLog "ABORT fma_large.zip failed integrity test"
        exit 3
    }
    Write-JobLog "EXTRACT fma_large -> $FmaLargeDest"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $tarExe -xf $FmaLargeZip -C $FmaLargeDest
    if ($LASTEXITCODE -ne 0) {
        Write-JobLog ("EXTRACT failed {0}" -f $LASTEXITCODE)
        exit $LASTEXITCODE
    }
    $sw.Stop()
    "source=$FmaLargeZip`nsource_bytes=$((Get-Item $FmaLargeZip).Length)`nextracted_utc=$((Get-Date).ToUniversalTime().ToString('o'))`nduration_sec=$([math]::Round($sw.Elapsed.TotalSeconds,1))" |
        Set-Content $marker -Encoding UTF8
    Write-JobLog ("fma_large extracted in {0} min" -f [math]::Round($sw.Elapsed.TotalMinutes, 1))
} else {
    Write-JobLog "fma_large already extracted"
}

Write-JobLog "unzip leftover sample packs"
$env:PYTHONPATH = Split-Path $Scripts -Parent
& $PythonExe (Join-Path $Scripts "unzip_eligible_zips.py") --execute
if ($LASTEXITCODE -ne 0) { Write-JobLog "unzip_eligible exit $LASTEXITCODE" }

Write-JobLog "start slicing campaign WITH scan (new folders)"
$slice = Start-Process -FilePath "C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @(
    "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass",
    "-File",(Join-Path $Scripts "run_slicing_campaign.ps1"),
    "-Execute","-Workers","8"
) -WindowStyle Hidden -PassThru
Write-JobLog ("slicer_restart_pid={0}" -f $slice.Id)
exit 0
