# nssm_watchdog_setup.ps1
# Registers the Hybrid 1.0 Watchdog Slicing Daemon as a persistent Windows service

. "$PSScriptRoot\resolve_python.ps1"

$ServiceName = "HybridWatchdogDaemon"
$PythonPath = Assert-HybridPython
$ScriptPath = "D:\MusicDatasets\scripts\watchdog_slicing_daemon.py"

if (!(Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] NSSM is not installed or not found in system PATH."
    Write-Host "Install via: choco install nssm"
    exit 1
}

Write-Host "================================================================"
Write-Host "HYBRID 1.0 - WATCHDOG SERVICE REGISTRATION"
Write-Host "================================================================"

Write-Host "Registering $ServiceName via NSSM..."

nssm install $ServiceName $PythonPath $ScriptPath
nssm set $ServiceName AppDirectory "D:\MusicDatasets\scripts"
nssm set $ServiceName Description "Hybrid 1.0 Automated Watchdog Audio Ingestion and Slicing Daemon"
nssm set $ServiceName Start SERVICE_AUTO_START

Write-Host "Starting service..."
nssm start $ServiceName

Write-Host "================================================================"
Write-Host "[SUCCESS] Watchdog daemon is now running persistently as a Windows service."
Write-Host ""
Write-Host "Management commands:"
Write-Host "  nssm status $ServiceName"
Write-Host "  nssm stop $ServiceName"
Write-Host "  nssm restart $ServiceName"
Write-Host "  nssm remove $ServiceName"
Write-Host "================================================================"
