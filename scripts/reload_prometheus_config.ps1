# D:\MusicDatasets\scripts\reload_prometheus_config.ps1
$ErrorActionPreference = "Stop"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - PROMETHEUS CONFIGURATION RELOAD" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# Validate rule syntax with promtool if available
$Promtool = "D:\MusicDatasets\monitoring\prometheus\promtool.exe"
$AlertsConfig = "D:\MusicDatasets\config\alerts.yml"
$PromConfig = "D:\MusicDatasets\config\prometheus.yml"

if (Test-Path $Promtool) {
    if (Test-Path $AlertsConfig) {
        Write-Host "[VALIDATE] Checking rule syntax in $AlertsConfig..."
        & $Promtool check rules $AlertsConfig
        if ($LASTEXITCODE -ne 0) {
            throw "promtool validation failed for $AlertsConfig"
        }
        Write-Host "  -> Rule syntax valid." -ForegroundColor Green
    } else {
        Write-Host "[WARN] $AlertsConfig not found. Run deploy_to_workstation.ps1 first." -ForegroundColor Yellow
    }

    if (Test-Path $PromConfig) {
        Write-Host "[VALIDATE] Checking $PromConfig..."
        & $Promtool check config $PromConfig
        if ($LASTEXITCODE -ne 0) {
            throw "promtool validation failed for $PromConfig"
        }
        Write-Host "  -> Config valid." -ForegroundColor Green
    }
} else {
    Write-Host "[SKIP] promtool.exe not found at $Promtool; reloading without validation." -ForegroundColor Yellow
}

# Trigger live reload endpoint without restarting the Windows daemon.
# This requires Prometheus to have been started with --web.enable-lifecycle,
# which register_monitoring_services.ps1 leaves OFF by default (the endpoint is
# unauthenticated and also exposes /-/quit). Without it this returns 404 and the
# service restart below is the expected path, not a failure.
Write-Host "[RELOAD] Sending HTTP POST reload signal to Prometheus (Port 9090)..."

try {
    $Response = Invoke-WebRequest -Uri "http://127.0.0.1:9090/-/reload" -Method Post -TimeoutSec 10 -UseBasicParsing

    if ($Response.StatusCode -eq 200) {
        Write-Host "[SUCCESS] Prometheus configuration and alerting rules reloaded successfully." -ForegroundColor Green
    }
} catch {
    $status = $_.Exception.Response.StatusCode.value__

    if ($status -eq 404) {
        Write-Host "[INFO] Lifecycle API disabled (404). Restart the service to apply changes." -ForegroundColor Yellow
        Write-Host "       Re-register with -EnablePrometheusLifecycle to enable hot reload." -ForegroundColor Gray
    } else {
        Write-Host "[ERROR] Failed to reload Prometheus via HTTP: $($_.Exception.Message)" -ForegroundColor Red
    }

    if (Get-Service -Name "HybridPrometheusDaemon" -ErrorAction SilentlyContinue) {
        Write-Host "Restarting service via NSSM as fallback..." -ForegroundColor Yellow
        Restart-Service -Name "HybridPrometheusDaemon" -Force
        Write-Host "[SUCCESS] HybridPrometheusDaemon restarted." -ForegroundColor Green
    } else {
        Write-Host "[WARN] HybridPrometheusDaemon is not registered; nothing to restart." -ForegroundColor Yellow
    }
}
