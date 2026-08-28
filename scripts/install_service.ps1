# scripts/install_service.ps1
# Run as Administrator to register HybridWorkerDaemon via NSSM

$ServiceName = "HybridWorkerDaemon"
$PythonPath = (Get-Command python).Source
$ScriptPath = "D:\MusicDatasets\scripts\master_daemon_pipeline.py"
$WorkingDir = "D:\MusicDatasets"
$LogDir = "D:\MusicDatasets\logs"

if (!(Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

Write-Host "Installing Windows Background Service: $ServiceName..." -ForegroundColor Cyan

if (!(Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "Error: NSSM (Non-Sucking Service Manager) is not found in PATH. Please install NSSM first." -ForegroundColor Red
    exit 1
}

nssm install $ServiceName $PythonPath "`"$ScriptPath`""
nssm set $ServiceName AppDirectory $WorkingDir
nssm set $ServiceName Description "Hybrid 1.0 Alpha Autonomous Background Processing Daemon"
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppStdout "$LogDir\daemon_stdout.log"
nssm set $ServiceName AppStderr "$LogDir\daemon_stderr.log"

Write-Host "Service $ServiceName successfully installed and configured for auto-start." -ForegroundColor Green
Write-Host "To start the service now, run: nssm start $ServiceName" -ForegroundColor Yellow
