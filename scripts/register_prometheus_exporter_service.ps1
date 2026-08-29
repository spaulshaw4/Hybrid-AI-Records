# D:\MusicDatasets\scripts\register_prometheus_exporter_service.ps1
. "$PSScriptRoot\resolve_python.ps1"

$ServiceName = "HybridPrometheusExporterDaemon"
$PythonPath = Assert-HybridPython
$ScriptPath = "D:\MusicDatasets\scripts\prometheus_exporter.py"
$LogDir = "D:\MusicDatasets\logs"

if (!(Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] NSSM is not installed or not found in system PATH." -ForegroundColor Red
    exit 1
}

Write-Host "Registering $ServiceName via NSSM..." -ForegroundColor Cyan

nssm install $ServiceName $PythonPath $ScriptPath
nssm set $ServiceName AppDirectory "D:\MusicDatasets\scripts"
nssm set $ServiceName Description "Hybrid 1.0 Prometheus Metrics Exporter (Port 9191)"
nssm set $ServiceName Start SERVICE_AUTO_START

# Logging and Rotation
nssm set $ServiceName AppStdout "$LogDir\prometheus_exporter_stdout.log"
nssm set $ServiceName AppStderr "$LogDir\prometheus_exporter_stderr.log"
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateBytes 10485760

# Supabase credentials must be injected explicitly: NSSM services run as
# LOCAL SYSTEM and do not inherit the interactive user's environment.
if ($env:SUPABASE_URL -and $env:SUPABASE_SERVICE_ROLE_KEY) {
    nssm set $ServiceName AppEnvironmentExtra `
        "SUPABASE_URL=$($env:SUPABASE_URL)" `
        "SUPABASE_SERVICE_ROLE_KEY=$($env:SUPABASE_SERVICE_ROLE_KEY)"
    Write-Host "  -> Injected Supabase credentials into service environment." -ForegroundColor Gray
} else {
    Write-Host "[WARN] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in this shell." -ForegroundColor Yellow
    Write-Host "       The exporter will exit on start until they are provided via:" -ForegroundColor Yellow
    Write-Host "       nssm set $ServiceName AppEnvironmentExtra SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=..." -ForegroundColor Yellow
}

nssm start $ServiceName

Write-Host "[SUCCESS] HybridPrometheusExporterDaemon registered and running on port 9191." -ForegroundColor Green
