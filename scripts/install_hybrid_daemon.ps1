<#
.SYNOPSIS
    Install Hybrid 1.0 Daemon Poller as a Windows Service using NSSM
.DESCRIPTION
    Registers the daemon_poller.py script as a persistent background service
    that automatically starts on system boot.
.NOTES
    Requires Administrator privileges and NSSM installed.
#>

#Requires -RunAsAdministrator

$ServiceName = "HybridDaemon"
$PythonPath = (Get-Command python -ErrorAction SilentlyContinue).Source
$ScriptPath = "D:\MusicDatasets\scripts\daemon_poller.py"
$WorkDir = "D:\MusicDatasets\scripts"
$LogDir = "D:\MusicDatasets\logs"

# Check if NSSM is available
$NssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $NssmPath) {
    Write-Host "[ERROR] NSSM not found. Install via: choco install nssm" -ForegroundColor Red
    Write-Host "        Or download from: https://nssm.cc/download" -ForegroundColor Yellow
    exit 1
}

# Check if Python is available
if (-not $PythonPath) {
    Write-Host "[ERROR] Python not found in PATH." -ForegroundColor Red
    exit 1
}

Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - DAEMON SERVICE INSTALLER" -ForegroundColor Cyan
Write-Host "==============================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Python Path: $PythonPath" -ForegroundColor Gray
Write-Host "Script Path: $ScriptPath" -ForegroundColor Gray
Write-Host "Work Dir:    $WorkDir" -ForegroundColor Gray
Write-Host ""

# Check if service already exists
$ExistingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($ExistingService) {
    Write-Host "[WARNING] Service '$ServiceName' already exists. Removing..." -ForegroundColor Yellow
    & nssm stop $ServiceName 2>$null
    & nssm remove $ServiceName confirm
}

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Install service
Write-Host "[1/5] Installing service..." -ForegroundColor Cyan
& nssm install $ServiceName $PythonPath $ScriptPath

# Configure working directory
Write-Host "[2/5] Setting working directory..." -ForegroundColor Cyan
& nssm set $ServiceName AppDirectory $WorkDir

# Configure description and auto-start
Write-Host "[3/5] Configuring auto-start..." -ForegroundColor Cyan
& nssm set $ServiceName Description "Hybrid 1.0 Autonomous Supabase Audio Pipeline Daemon"
& nssm set $ServiceName Start SERVICE_AUTO_START

# Configure logging
Write-Host "[4/5] Configuring log rotation..." -ForegroundColor Cyan
& nssm set $ServiceName AppStdout "$LogDir\daemon_stdout.log"
& nssm set $ServiceName AppStderr "$LogDir\daemon_stderr.log"
& nssm set $ServiceName AppRotateFiles 1
& nssm set $ServiceName AppRotateOnline 1
& nssm set $ServiceName AppRotateBytes 10485760

# Start the service
Write-Host "[5/5] Starting service..." -ForegroundColor Cyan
& nssm start $ServiceName

Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Green
Write-Host "[SUCCESS] HybridDaemon service installed and running!" -ForegroundColor Green
Write-Host ""
Write-Host "  Manage with:" -ForegroundColor Cyan
Write-Host "    nssm start HybridDaemon    - Start service" -ForegroundColor Gray
Write-Host "    nssm stop HybridDaemon     - Stop service" -ForegroundColor Gray
Write-Host "    nssm restart HybridDaemon  - Restart service" -ForegroundColor Gray
Write-Host "    nssm edit HybridDaemon     - Edit configuration (GUI)" -ForegroundColor Gray
Write-Host ""
Write-Host "  View logs:" -ForegroundColor Cyan
Write-Host "    $LogDir\daemon_stdout.log" -ForegroundColor Gray
Write-Host "    $LogDir\daemon_stderr.log" -ForegroundColor Gray
Write-Host "==============================================================================" -ForegroundColor Green
