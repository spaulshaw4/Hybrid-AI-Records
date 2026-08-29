# D:\MusicDatasets\scripts\tail_logs.ps1
param(
    [ValidateSet("all", "watchdog", "audio", "storage", "exporter", "prometheus", "alertmanager")]
    [string]$Service = "all",
    [int]$Lines = 30,
    [switch]$NoWait = $false
)

$BaseDir = "D:\MusicDatasets"
$LogDir = Join-Path $BaseDir "logs"

if (!(Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$LogMappings = @{
    "watchdog"     = @("watchdog_stdout.log", "watchdog_stderr.log")
    "audio"        = @("audio_daemon_stdout.log", "audio_daemon_stderr.log")
    "storage"      = @("storage_guard_stdout.log", "storage_guard_stderr.log")
    "exporter"     = @("prometheus_exporter_stdout.log", "prometheus_exporter_stderr.log")
    "prometheus"   = @("prometheus_stdout.log", "prometheus_stderr.log")
    "alertmanager" = @("alertmanager_stdout.log", "alertmanager_stderr.log")
}

# Determine target log files
$TargetFiles = @()

if ($Service -eq "all") {
    foreach ($key in $LogMappings.Keys) {
        foreach ($file in $LogMappings[$key]) {
            $TargetFiles += (Join-Path $LogDir $file)
        }
    }
} else {
    foreach ($file in $LogMappings[$Service]) {
        $TargetFiles += (Join-Path $LogDir $file)
    }
}

# Touch missing log files to prevent Get-Content errors
foreach ($path in $TargetFiles) {
    if (!(Test-Path $path)) {
        New-Item -ItemType File -Force -Path $path | Out-Null
    }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - UNIFIED LOG STREAMER" -ForegroundColor Cyan
Write-Host "Target Scope : $Service"
Write-Host "Initial Lines: $Lines"
Write-Host "Monitoring   : $($TargetFiles.Count) log targets in $LogDir"
Write-Host "Mode         : $(if ($NoWait) { 'Snapshot (No Follow)' } else { 'Continuous Follow (Ctrl+C to Exit)' })"
Write-Host "================================================================" -ForegroundColor Cyan

if (-not $NoWait -and $TargetFiles.Count -gt 1) {
    Write-Host "[NOTE] Get-Content -Wait follows only the last path when given several." -ForegroundColor Yellow
    Write-Host "       Pass -Service <name> to follow one subsystem, or -NoWait for a snapshot of all." -ForegroundColor Yellow
    Write-Host ""
}

if ($NoWait) {
    Get-Content -Path $TargetFiles -Tail $Lines
} else {
    Get-Content -Path $TargetFiles -Tail $Lines -Wait
}
