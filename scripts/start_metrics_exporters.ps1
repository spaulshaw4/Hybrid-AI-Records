<#
.SYNOPSIS
    Validate (and optionally start) the two Prometheus exporters. No NSSM.
.DESCRIPTION
    prometheus.yml already scrapes 127.0.0.1:9192 (audio/DSP) and
    127.0.0.1:9193 (token balances), so both targets read DOWN until these
    processes run. This resolves Get-HybridPython, checks the exporter files
    and the prometheus_client import, and reports port occupancy.

    Default is validate-only. -Start launches each exporter in its own visible
    window. This script never registers a service and never touches
    HybridAudioDaemon; 9090 belongs to the Prometheus TSDB and is refused.
.EXAMPLE
    .\start_metrics_exporters.ps1
    .\start_metrics_exporters.ps1 -Start
#>
[CmdletBinding()]
param(
    [switch]$Start,
    [string]$BaseDir = "D:\MusicDatasets",
    [int]$AudioPort = 9192,
    [int]$TokenPort = 9193
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

foreach ($port in @($AudioPort, $TokenPort)) {
    if ($port -eq 9090) {
        Write-Host "[ERROR] 9090 is the Prometheus TSDB. Refusing to bind it." -ForegroundColor Red
        exit 1
    }
}
if ($AudioPort -eq $TokenPort) {
    Write-Host "[ERROR] AudioPort and TokenPort must differ." -ForegroundColor Red
    exit 1
}

$ResolvePython = Join-Path $PSScriptRoot "resolve_python.ps1"
if (-not (Test-Path $ResolvePython)) {
    $ResolvePython = Join-Path $BaseDir "scripts\resolve_python.ps1"
}
if (-not (Test-Path $ResolvePython)) {
    Write-Host "[ERROR] resolve_python.ps1 not found" -ForegroundColor Red
    exit 1
}
. $ResolvePython
$python = Get-HybridPython
if (-not $python) { throw "Python interpreter not resolvable (Get-HybridPython)." }

# Prefer the deployed copy under D:\MusicDatasets\monitoring, fall back to the repo.
function Resolve-Exporter {
    param([string]$Name)
    foreach ($candidate in @((Join-Path $BaseDir "monitoring\$Name"), (Join-Path $RepoRoot "monitoring\$Name"))) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

$exporters = @(
    [pscustomobject]@{ Label = "audio"; Name = "prometheus_audio_exporter.py"; Port = $AudioPort; EnvVar = "PROMETHEUS_AUDIO_EXPORTER_PORT" },
    [pscustomobject]@{ Label = "token"; Name = "token_metrics_exporter.py";    Port = $TokenPort; EnvVar = "PROMETHEUS_TOKEN_EXPORTER_PORT" }
)

Write-Host "[STATUS] python=$python"

& $python -c "import prometheus_client" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] python package prometheus_client is missing - exporters cannot run" -ForegroundColor Red
    exit 1
}
Write-Host "[OK]    python package: prometheus_client"

$db = Join-Path $BaseDir "database\master_catalog.db"
if (Test-Path $db) {
    Write-Host "[OK]    ledger $db"
} else {
    Write-Host "[WARN] ledger missing at $db - exporters will serve zeroed metrics" -ForegroundColor Yellow
}

$ready = $true
foreach ($exp in $exporters) {
    $path = Resolve-Exporter -Name $exp.Name
    if (-not $path) {
        Write-Host "[ERROR] $($exp.Name) not found under $BaseDir\monitoring or $RepoRoot\monitoring" -ForegroundColor Red
        $ready = $false
        continue
    }
    $exp | Add-Member -NotePropertyName Path -NotePropertyValue $path -Force

    $inUse = @(Get-NetTCPConnection -LocalPort $exp.Port -State Listen -ErrorAction SilentlyContinue)
    if ($inUse.Count -gt 0) {
        $exp | Add-Member -NotePropertyName Occupied -NotePropertyValue $true -Force
        Write-Host "[OK]    $($exp.Label) exporter port $($exp.Port) already has a listener (will not start a second one)"
    } else {
        $exp | Add-Member -NotePropertyName Occupied -NotePropertyValue $false -Force
        Write-Host "[READY] $($exp.Label) exporter $path -> 127.0.0.1:$($exp.Port)"
    }
}

if (-not $ready) { exit 1 }

if (-not $Start) {
    Write-Host "[VALIDATE] not starting exporters. Pass -Start for visible windows."
    exit 0
}

foreach ($exp in $exporters) {
    if ($exp.Occupied) {
        Write-Host "[SKIP]  $($exp.Label) exporter - port $($exp.Port) is already listening"
        continue
    }
    Write-Host "[START] $($exp.Label): $python $($exp.Path) (port $($exp.Port))"
    $argList = @(
        "-NoExit",
        "-Command",
        "`$env:$($exp.EnvVar)='$($exp.Port)'; & '$python' '$($exp.Path)'"
    )
    Start-Process -FilePath "powershell.exe" -ArgumentList $argList
}
exit 0
