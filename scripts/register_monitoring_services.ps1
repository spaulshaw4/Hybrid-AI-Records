# D:\MusicDatasets\scripts\register_monitoring_services.ps1
param(
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$PrometheusBinDir = "D:\MusicDatasets\monitoring\prometheus",
    [string]$AlertmanagerBinDir = "D:\MusicDatasets\monitoring\alertmanager",

    # Loopback by default. Neither Prometheus nor Alertmanager ships with
    # authentication, and these are SERVICE_AUTO_START services, so a wider
    # bind here is permanent exposure rather than a one-off session.
    [string]$PrometheusBind = "127.0.0.1:9090",
    [string]$AlertmanagerBind = "127.0.0.1:9093",

    # /-/reload and /-/quit are unauthenticated when lifecycle is enabled.
    [switch]$EnablePrometheusLifecycle = $false
)

$ErrorActionPreference = "Stop"

$LogDir = Join-Path $BaseDir "logs"
$ConfigDir = Join-Path $BaseDir "config"
$PromDataDir = Join-Path $BaseDir "monitoring\data\prometheus"
$AlertDataDir = Join-Path $BaseDir "monitoring\data\alertmanager"

# Ensure directories exist
@( $LogDir, $ConfigDir, $PromDataDir, $AlertDataDir ) | ForEach-Object {
    if (!(Test-Path $_)) { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
}

# Verify NSSM binary
if (!(Get-Command nssm -ErrorAction SilentlyContinue)) {
    throw "NSSM binary not found in system PATH. Install NSSM or add it to PATH."
}

$PromExe = Join-Path $PrometheusBinDir "prometheus.exe"
$AlertExe = Join-Path $AlertmanagerBinDir "alertmanager.exe"
$PromConfig = Join-Path $ConfigDir "prometheus.yml"
$AlertConfig = Join-Path $ConfigDir "alertmanager.yml"

if (!(Test-Path $PromExe)) { throw "Prometheus binary not found at $PromExe" }
if (!(Test-Path $AlertExe)) { throw "Alertmanager binary not found at $AlertExe" }
if (!(Test-Path $PromConfig)) { throw "Prometheus configuration file not found at $PromConfig. Run deploy_to_workstation.ps1 first." }
if (!(Test-Path $AlertConfig)) { throw "Alertmanager configuration file not found at $AlertConfig. Run deploy_to_workstation.ps1 first." }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - MONITORING SERVICE REGISTRATION (NSSM)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

foreach ($bind in @($PrometheusBind, $AlertmanagerBind)) {
    if ($bind -notlike "127.0.0.1:*" -and $bind -notlike "localhost:*") {
        Write-Host "[WARN] $bind is reachable beyond loopback with no authentication." -ForegroundColor Yellow
    }
}

# -------------------------------------------------------------------------
# 1. REGISTER PROMETHEUS SERVICE
# -------------------------------------------------------------------------
$PromService = "HybridPrometheusDaemon"
$PromArgs = "--config.file=`"$PromConfig`" --storage.tsdb.path=`"$PromDataDir`" --web.listen-address=`"$PrometheusBind`""

if ($EnablePrometheusLifecycle) {
    $PromArgs += " --web.enable-lifecycle"
    if ($PrometheusBind -notlike "127.0.0.1:*" -and $PrometheusBind -notlike "localhost:*") {
        Write-Host "[WARN] Lifecycle API enabled on a non-loopback bind: anyone who can reach" -ForegroundColor Red
        Write-Host "       $PrometheusBind can POST /-/quit and stop metrics collection." -ForegroundColor Red
    }
}

Write-Host "[INSTALL] Configuring $PromService..."

if (Get-Service -Name $PromService -ErrorAction SilentlyContinue) {
    nssm stop $PromService | Out-Null
    nssm remove $PromService confirm | Out-Null
}

nssm install $PromService $PromExe $PromArgs
nssm set $PromService AppDirectory $PrometheusBinDir
nssm set $PromService Description "Hybrid 1.0 Prometheus Metrics Aggregator ($PrometheusBind)"
nssm set $PromService Start SERVICE_AUTO_START

# Logging and 10MB Rotation
nssm set $PromService AppStdout "$LogDir\prometheus_stdout.log"
nssm set $PromService AppStderr "$LogDir\prometheus_stderr.log"
nssm set $PromService AppRotateFiles 1
nssm set $PromService AppRotateBytes 10485760

nssm start $PromService
Write-Host "  -> $PromService registered and running on http://$PrometheusBind" -ForegroundColor Green

# -------------------------------------------------------------------------
# 2. REGISTER ALERTMANAGER SERVICE
# -------------------------------------------------------------------------
$AlertService = "HybridAlertmanagerDaemon"
$AlertArgs = "--config.file=`"$AlertConfig`" --storage.path=`"$AlertDataDir`" --web.listen-address=`"$AlertmanagerBind`""

Write-Host "[INSTALL] Configuring $AlertService..."

if (Get-Service -Name $AlertService -ErrorAction SilentlyContinue) {
    nssm stop $AlertService | Out-Null
    nssm remove $AlertService confirm | Out-Null
}

nssm install $AlertService $AlertExe $AlertArgs
nssm set $AlertService AppDirectory $AlertmanagerBinDir
nssm set $AlertService Description "Hybrid 1.0 Alertmanager Webhook Dispatcher ($AlertmanagerBind)"
nssm set $AlertService Start SERVICE_AUTO_START

# Logging and 10MB Rotation
nssm set $AlertService AppStdout "$LogDir\alertmanager_stdout.log"
nssm set $AlertService AppStderr "$LogDir\alertmanager_stderr.log"
nssm set $AlertService AppRotateFiles 1
nssm set $AlertService AppRotateBytes 10485760

nssm start $AlertService
Write-Host "  -> $AlertService registered and running on http://$AlertmanagerBind" -ForegroundColor Green

# -------------------------------------------------------------------------
# 3. VERIFY STATUS
# -------------------------------------------------------------------------
Start-Sleep -Seconds 2

Write-Host "`n[VERIFY] Service Status Summary:" -ForegroundColor Yellow
Get-Service -Name "Hybrid*" | Format-Table -AutoSize
