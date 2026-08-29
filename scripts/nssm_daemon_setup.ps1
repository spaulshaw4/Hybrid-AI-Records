# nssm_daemon_setup.ps1
# Registers the Hybrid 1.0 Daemon Poller as a persistent Windows service

. "$PSScriptRoot\resolve_python.ps1"

$ServiceName = "HybridAudioDaemon"
$PythonPath = Assert-HybridPython
$ScriptPath = "D:\MusicDatasets\scripts\daemon_poller.py"

if (!(Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] NSSM is not installed or not found in system PATH."
    Write-Host "Install via: choco install nssm"
    exit 1
}

Write-Host "================================================================"
Write-Host "HYBRID 1.0 - DAEMON SERVICE REGISTRATION"
Write-Host "================================================================"

Write-Host "Registering $ServiceName via NSSM..."

nssm install $ServiceName $PythonPath $ScriptPath
nssm set $ServiceName AppDirectory "D:\MusicDatasets\scripts"
nssm set $ServiceName Description "Hybrid 1.0 Local Workstation Supabase Polling & Pipeline Orchestrator Daemon"
nssm set $ServiceName Start SERVICE_AUTO_START

Write-Host "Starting service..."
nssm start $ServiceName

Write-Host "================================================================"
Write-Host "[SUCCESS] Local pipeline daemon is now running persistently as a Windows service."
Write-Host ""
Write-Host "Management commands:"
Write-Host "  nssm status $ServiceName"
Write-Host "  nssm stop $ServiceName"
Write-Host "  nssm restart $ServiceName"
Write-Host "  nssm remove $ServiceName"
Write-Host "================================================================"
