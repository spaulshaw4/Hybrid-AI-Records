# D:\MusicDatasets\scripts\register_stagnation_healer_service.ps1

. "$PSScriptRoot\resolve_python.ps1"

$ServiceName = "HybridStagnationHealerDaemon"
$PythonPath = Assert-HybridPython
$ScriptPath = "D:\MusicDatasets\scripts\pipeline_stagnation_healer.py"
$LogDir = "D:\MusicDatasets\logs"

if (!(Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] NSSM is not installed or not found in system PATH." -ForegroundColor Red
    exit 1
}

if (!(Test-Path $ScriptPath)) {
    Write-Host "[ERROR] $ScriptPath not found. Run deploy_to_workstation.ps1 first." -ForegroundColor Red
    exit 1
}

Write-Host "Registering $ServiceName via NSSM..." -ForegroundColor Cyan

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    nssm stop $ServiceName | Out-Null
    nssm remove $ServiceName confirm | Out-Null
}

nssm install $ServiceName $PythonPath $ScriptPath
nssm set $ServiceName AppDirectory "D:\MusicDatasets\scripts"
nssm set $ServiceName Description "Hybrid 1.0 Automatic Pipeline Stagnation and Dead-Letter Recovery Daemon"
nssm set $ServiceName Start SERVICE_AUTO_START

# Logging and 10MB Rotation. Filenames match the $LogMappings table in tail_logs.ps1.
nssm set $ServiceName AppStdout "$LogDir\stagnation_healer_stdout.log"
nssm set $ServiceName AppStderr "$LogDir\stagnation_healer_stderr.log"
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateBytes 10485760

# NSSM services run as LOCAL SYSTEM and inherit only Machine-scoped variables.
# The healer exits immediately without Supabase credentials.
$machineUrl = [Environment]::GetEnvironmentVariable("SUPABASE_URL", "Machine")
$machineKey = [Environment]::GetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY", "Machine")

if (-not $machineUrl -or -not $machineKey) {
    if ($env:SUPABASE_URL -and $env:SUPABASE_SERVICE_ROLE_KEY) {
        nssm set $ServiceName AppEnvironmentExtra `
            "SUPABASE_URL=$($env:SUPABASE_URL)" `
            "SUPABASE_SERVICE_ROLE_KEY=$($env:SUPABASE_SERVICE_ROLE_KEY)"
        Write-Host "  -> Injected Supabase credentials from this shell into the service." -ForegroundColor Gray
    } else {
        Write-Host "[WARN] Supabase credentials not set at Machine scope and not present in this shell." -ForegroundColor Yellow
        Write-Host "       The healer will exit on start until they are provided." -ForegroundColor Yellow
    }
}

nssm start $ServiceName

Write-Host "[SUCCESS] $ServiceName registered and started as a persistent background service." -ForegroundColor Green
Write-Host "  Interpreter: $PythonPath" -ForegroundColor Gray
