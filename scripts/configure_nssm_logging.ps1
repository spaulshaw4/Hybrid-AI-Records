# configure_nssm_logging.ps1
# Configures NSSM output logging with automatic 10MB file rotation

$LogDir = "D:\MusicDatasets\logs"

if (!(Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir
}

Write-Host "================================================================"
Write-Host "HYBRID 1.0 - NSSM LOGGING CONFIGURATION"
Write-Host "================================================================"

# 1. Configure HybridWatchdogDaemon Logging & Rotation
Write-Host "Configuring HybridWatchdogDaemon logging..."
nssm set HybridWatchdogDaemon AppStdout "$LogDir\watchdog_stdout.log"
nssm set HybridWatchdogDaemon AppStderr "$LogDir\watchdog_stderr.log"
nssm set HybridWatchdogDaemon AppRotateFiles 1
nssm set HybridWatchdogDaemon AppRotateBytes 10485760

# 2. Configure HybridAudioDaemon Logging & Rotation
#    Filenames must match the $LogMappings table in tail_logs.ps1.
Write-Host "Configuring HybridAudioDaemon logging..."
nssm set HybridAudioDaemon AppStdout "$LogDir\audio_daemon_stdout.log"
nssm set HybridAudioDaemon AppStderr "$LogDir\audio_daemon_stderr.log"
nssm set HybridAudioDaemon AppRotateFiles 1
nssm set HybridAudioDaemon AppRotateBytes 10485760

# 3. Configure HybridStorageGuardDaemon Logging & Rotation (if registered)
if (Get-Service -Name "HybridStorageGuardDaemon" -ErrorAction SilentlyContinue) {
    Write-Host "Configuring HybridStorageGuardDaemon logging..."
    nssm set HybridStorageGuardDaemon AppStdout "$LogDir\storage_guard_stdout.log"
    nssm set HybridStorageGuardDaemon AppStderr "$LogDir\storage_guard_stderr.log"
    nssm set HybridStorageGuardDaemon AppRotateFiles 1
    nssm set HybridStorageGuardDaemon AppRotateBytes 10485760
} else {
    Write-Host "[SKIP] HybridStorageGuardDaemon is not registered - no log redirection applied." -ForegroundColor Yellow
}

# Restart services to apply redirection parameters
Write-Host "Restarting services to apply logging configuration..."
Restart-Service HybridWatchdogDaemon -ErrorAction SilentlyContinue
Restart-Service HybridAudioDaemon -ErrorAction SilentlyContinue

Write-Host "================================================================"
Write-Host "[SUCCESS] NSSM output streams redirected to $LogDir"
Write-Host "Log files:"
Write-Host "  - $LogDir\watchdog_stdout.log"
Write-Host "  - $LogDir\watchdog_stderr.log"
Write-Host "  - $LogDir\daemon_stdout.log"
Write-Host "  - $LogDir\daemon_stderr.log"
Write-Host "Automatic rotation at 10MB per file."
Write-Host "================================================================"
