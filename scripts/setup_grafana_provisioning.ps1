# D:\MusicDatasets\scripts\setup_grafana_provisioning.ps1
param(
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$GrafanaInstallDir = "C:\Program Files\GrafanaLabs\grafana",
    [switch]$RestartGrafana = $false
)

$ErrorActionPreference = "Stop"

$DashboardsDir = Join-Path $BaseDir "monitoring\grafana\dashboards"
$ProvDashDir   = Join-Path $BaseDir "monitoring\grafana\provisioning\dashboards"
$ProvDataDir   = Join-Path $BaseDir "monitoring\grafana\provisioning\datasources"

# 1. Create target directories
@( $DashboardsDir, $ProvDashDir, $ProvDataDir ) | ForEach-Object {
    if (!(Test-Path $_)) { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - GRAFANA PROVISIONING SETUP" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# 2. Copy provisioning configs into the Grafana install tree if present
$GrafanaProvisioningDir = Join-Path $GrafanaInstallDir "conf\provisioning"

if (Test-Path $GrafanaProvisioningDir) {
    $dashSrc = Join-Path $ProvDashDir "hybrid_dashboards.yml"
    $dataSrc = Join-Path $ProvDataDir "hybrid_datasources.yml"

    if (-not (Test-Path $dashSrc) -or -not (Test-Path $dataSrc)) {
        Write-Host "[ERROR] Provisioning YAML missing under $BaseDir\monitoring\grafana\provisioning." -ForegroundColor Red
        Write-Host "        Run deploy_to_workstation.ps1 to sync them from the repo." -ForegroundColor Yellow
        exit 1
    }

    foreach ($sub in @("dashboards", "datasources")) {
        $target = Join-Path $GrafanaProvisioningDir $sub
        if (!(Test-Path $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
    }

    Copy-Item -Path $dashSrc -Destination (Join-Path $GrafanaProvisioningDir "dashboards") -Force
    Copy-Item -Path $dataSrc -Destination (Join-Path $GrafanaProvisioningDir "datasources") -Force
    Write-Host "[SUCCESS] Copied provisioning configs directly to Grafana install tree." -ForegroundColor Green
} else {
    Write-Host "[INFO] Standard Grafana directory not found at $GrafanaInstallDir." -ForegroundColor Yellow
    Write-Host "       Set the 'provisioning' path in your custom grafana.ini to point to:"
    Write-Host "       $BaseDir\monitoring\grafana\provisioning" -ForegroundColor Cyan
}

# 3. Verify dashboards are present in the watched folder.
#    Checked by pattern, not a fixed filename: the repo ships
#    hybrid_workstation_dashboard.json and hybrid_observability_dashboard.json,
#    and more may be added.
$found = @(Get-ChildItem -Path $DashboardsDir -Filter "*.json" -File -ErrorAction SilentlyContinue)

if ($found.Count -gt 0) {
    Write-Host "[VERIFIED] $($found.Count) dashboard JSON file(s) in $DashboardsDir" -ForegroundColor Green
    foreach ($f in $found) {
        try {
            $json = Get-Content $f.FullName -Raw | ConvertFrom-Json
            Write-Host "  - $($f.Name)  uid=$($json.uid)  title='$($json.title)'" -ForegroundColor Gray
        } catch {
            Write-Host "  - $($f.Name)  [INVALID JSON]" -ForegroundColor Red
        }
    }
} else {
    Write-Host "[WARN] No dashboard JSON found in $DashboardsDir" -ForegroundColor Yellow
    Write-Host "       Run deploy_to_workstation.ps1 to sync monitoring/grafana/*.json." -ForegroundColor Yellow
}

# 4. Optional service restart to pick up provisioning changes
if ($RestartGrafana) {
    $svc = Get-Service -Name "grafana" -ErrorAction SilentlyContinue
    if (-not $svc) { $svc = Get-Service -Name "Grafana" -ErrorAction SilentlyContinue }

    if ($svc) {
        Write-Host "`nRestarting $($svc.Name) to apply provisioning..." -ForegroundColor Yellow
        Restart-Service -Name $svc.Name -Force
        Write-Host "[SUCCESS] $($svc.Name) restarted." -ForegroundColor Green
    } else {
        Write-Host "`n[WARN] No Grafana service found. Provisioning is reloaded on next start." -ForegroundColor Yellow
    }
}
