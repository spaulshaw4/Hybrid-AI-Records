<#
.SYNOPSIS
    Hybrid 1.0 - Desktop Shortcut Generator
.DESCRIPTION
    Creates administrative shortcuts on the current user's desktop for the
    Control Center, Health Diagnostics, Live Log Streamer, and Web Observability UIs.
.PARAMETER GrafanaPort
    Grafana's HTTP port. Grafana and Next.js both default to 3000, so if the
    Next.js app serves /telemetry on 3000, move Grafana (grafana.ini http_port)
    and pass the new value here.
.PARAMETER AppPort
    Port serving the Next.js /telemetry and /vault pages.
#>

param(
    [int]$GrafanaPort = 3000,
    [int]$AppPort = 3000
)

$ErrorActionPreference = "Stop"

$BaseDir = "D:\MusicDatasets"
$ScriptsDir = Join-Path $BaseDir "scripts"
$DesktopDir = [Environment]::GetFolderPath("Desktop")
$WshShell = New-Object -ComObject WScript.Shell

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - DESKTOP SHORTCUT GENERATOR" -ForegroundColor Cyan
Write-Host "Desktop Target: $DesktopDir"
Write-Host "================================================================" -ForegroundColor Cyan

if ($GrafanaPort -eq $AppPort) {
    Write-Host "[WARN] Grafana and the Next.js app are both set to port $AppPort." -ForegroundColor Yellow
    Write-Host "       Only one can bind it. Grafana defaults to 3000 and so does" -ForegroundColor Yellow
    Write-Host "       'next dev'. Move Grafana via http_port in grafana.ini, then" -ForegroundColor Yellow
    Write-Host "       re-run with -GrafanaPort <new>." -ForegroundColor Yellow
}

# 1. Control Center Shell (.bat)
$BatShortcut = $WshShell.CreateShortcut((Join-Path $DesktopDir "Hybrid 1.0 Control Center.lnk"))
$BatShortcut.TargetPath = Join-Path $ScriptsDir "hybrid_control_center.bat"
$BatShortcut.WorkingDirectory = $ScriptsDir
$BatShortcut.Description = "Hybrid 1.0 Workstation Management Shell"
$BatShortcut.IconLocation = "shell32.dll,27"
$BatShortcut.Save()
Write-Host "[CREATED] Hybrid 1.0 Control Center.lnk" -ForegroundColor Green

# 2. Health & Readiness Diagnostics (PowerShell)
$HealthShortcut = $WshShell.CreateShortcut((Join-Path $DesktopDir "Hybrid 1.0 Health Diagnostics.lnk"))
$HealthShortcut.TargetPath = "powershell.exe"
$HealthShortcut.Arguments = "-NoExit -ExecutionPolicy Bypass -File `"$ScriptsDir\verify_pipeline_health.ps1`""
$HealthShortcut.WorkingDirectory = $ScriptsDir
$HealthShortcut.Description = "Run automated readiness and health matrix check"
$HealthShortcut.IconLocation = "shell32.dll,238"
$HealthShortcut.Save()
Write-Host "[CREATED] Hybrid 1.0 Health Diagnostics.lnk" -ForegroundColor Green

# 3. Unified Live Log Streamer (PowerShell)
$LogsShortcut = $WshShell.CreateShortcut((Join-Path $DesktopDir "Hybrid 1.0 Live Logs.lnk"))
$LogsShortcut.TargetPath = "powershell.exe"
$LogsShortcut.Arguments = "-NoExit -ExecutionPolicy Bypass -File `"$ScriptsDir\tail_logs.ps1`" -Service all"
$LogsShortcut.WorkingDirectory = $ScriptsDir
$LogsShortcut.Description = "Stream real-time log activity across all daemons"
$LogsShortcut.IconLocation = "shell32.dll,264"
$LogsShortcut.Save()
Write-Host "[CREATED] Hybrid 1.0 Live Logs.lnk" -ForegroundColor Green

# Helper: a here-string header must be followed immediately by a newline, so
# `@"[InternetShortcut]` is a parse error. Build the body as an array instead.
function New-UrlShortcut {
    param([string]$Path, [string]$Url)

    @(
        "[InternetShortcut]"
        "URL=$Url"
        "IconIndex=0"
        "IconFile=shell32.dll"
    ) | Out-File -FilePath $Path -Encoding ascii
}

# 4. Grafana Observability Dashboards (.url)
New-UrlShortcut -Path (Join-Path $DesktopDir "Hybrid 1.0 Grafana Dashboards.url") `
                -Url "http://localhost:$GrafanaPort/dashboards"
Write-Host "[CREATED] Hybrid 1.0 Grafana Dashboards.url  (port $GrafanaPort)" -ForegroundColor Green

# 5. Next.js Telemetry & Vault pages (.url)
New-UrlShortcut -Path (Join-Path $DesktopDir "Hybrid 1.0 Telemetry.url") `
                -Url "http://localhost:$AppPort/telemetry"
Write-Host "[CREATED] Hybrid 1.0 Telemetry.url  (port $AppPort)" -ForegroundColor Green

New-UrlShortcut -Path (Join-Path $DesktopDir "Hybrid 1.0 Vault Ledger.url") `
                -Url "http://localhost:$AppPort/vault"
Write-Host "[CREATED] Hybrid 1.0 Vault Ledger.url  (port $AppPort)" -ForegroundColor Green

# 6. Prometheus and Alertmanager (.url)
New-UrlShortcut -Path (Join-Path $DesktopDir "Hybrid 1.0 Prometheus.url") -Url "http://127.0.0.1:9090"
New-UrlShortcut -Path (Join-Path $DesktopDir "Hybrid 1.0 Alertmanager.url") -Url "http://127.0.0.1:9093"
Write-Host "[CREATED] Prometheus and Alertmanager shortcuts" -ForegroundColor Green

Write-Host "`nAll administrative shortcuts generated successfully on your Desktop." -ForegroundColor Cyan
