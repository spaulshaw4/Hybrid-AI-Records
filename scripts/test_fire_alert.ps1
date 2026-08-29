# D:\MusicDatasets\scripts\test_fire_alert.ps1
param(
    [ValidateSet("critical", "warning")]
    [string]$Severity = "critical",
    [string]$AlertmanagerUrl = "http://127.0.0.1:9093",
    [switch]$Resolve = $false,

    # amtool and the REST POST are two independent dispatch paths. Running both
    # delivers the same alert twice; enable this only to exercise amtool itself.
    [switch]$UseAmtool = $false
)

$ErrorActionPreference = "Stop"

$Now = (Get-Date).ToUniversalTime()
$StartsAt = $Now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$EndsAt = $(if ($Resolve) { $Now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") } else { $Now.AddMinutes(10).ToString("yyyy-MM-ddTHH:mm:ss.fffZ") })

# `target` must match the label used in alerts.yml (workstation_storage), because
# alertmanager.yml inhibits warning alerts using equal: ["target"]. A probe with
# a different target value would route correctly but never exercise inhibition.
$TargetLabel = "workstation_storage"

$AlertPayload = @(
    @{
        labels = @{
            alertname = $(if ($Severity -eq "critical") { "DriveDCriticalStorageExhaustion" } else { "DriveDLowStorageWarning" })
            severity  = $Severity
            target    = $TargetLabel
            drive     = "D:"
            instance  = "workstation-primary"
            env       = "production_test"
        }
        annotations = @{
            summary     = "SIMULATED TEST: $(if ($Resolve) { '[RESOLVED]' } else { '[FIRING]' }) $Severity alert"
            description = "Manual probe executed from test_fire_alert.ps1 to verify Alertmanager webhook dispatch pipeline."
        }
        startsAt = $StartsAt
        endsAt   = $EndsAt
    }
)

$JsonBody = $AlertPayload | ConvertTo-Json -Depth 5

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - ALERTMANAGER WEBHOOK PROBE" -ForegroundColor Cyan
Write-Host "Target Endpoint: $AlertmanagerUrl/api/v2/alerts"
Write-Host "Alert Severity : $Severity"
Write-Host "Target Label   : $TargetLabel"
Write-Host "Alert State    : $(if ($Resolve) { 'RESOLVED' } else { 'FIRING' })"
Write-Host "================================================================" -ForegroundColor Cyan

# Optional amtool dispatch path
if ($UseAmtool -and -not $Resolve) {
    $AmtoolPath = "D:\MusicDatasets\monitoring\alertmanager\amtool.exe"
    $AmtoolCmd = Get-Command "amtool" -ErrorAction SilentlyContinue

    if ($AmtoolCmd) {
        $AmtoolBin = $AmtoolCmd.Source
    } elseif (Test-Path $AmtoolPath) {
        $AmtoolBin = $AmtoolPath
    } else {
        $AmtoolBin = $null
        Write-Host "[WARN] -UseAmtool requested but amtool.exe was not found. Skipping." -ForegroundColor Yellow
    }

    if ($AmtoolBin) {
        Write-Host "[DISPATCH] Firing test alert via amtool ($AmtoolBin)..."
        & $AmtoolBin alert add `
            "alertname=$($AlertPayload[0].labels.alertname)" `
            "severity=$Severity" `
            "target=$TargetLabel" `
            "drive=D:" `
            "summary=$($AlertPayload[0].annotations.summary)" `
            --alertmanager.url=$AlertmanagerUrl
    }
}

# Direct REST API POST (API v2)
Write-Host "[DISPATCH] Posting alert payload to Alertmanager API v2..."

try {
    $Response = Invoke-RestMethod `
        -Uri "$AlertmanagerUrl/api/v2/alerts" `
        -Method Post `
        -Body $JsonBody `
        -ContentType "application/json" `
        -TimeoutSec 10

    Write-Host "[SUCCESS] Alert successfully pushed to Alertmanager." -ForegroundColor Green
    Write-Host "Check your Slack/Discord webhook channel for immediate notification delivery.`n"
} catch {
    Write-Host "[FAILURE] Failed to post alert to Alertmanager: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "          Confirm HybridAlertmanagerDaemon is running and listening on $AlertmanagerUrl." -ForegroundColor Yellow
    throw $_
}

# Verify active alerts from Alertmanager
Write-Host "[VERIFY] Fetching active alerts from Alertmanager..."

try {
    $ActiveAlerts = Invoke-RestMethod -Uri "$AlertmanagerUrl/api/v2/alerts" -Method Get -TimeoutSec 5
    $Matching = $ActiveAlerts | Where-Object { $_.labels.alertname -like "*DriveD*" }

    if ($Matching) {
        Write-Host "  -> Active Matching Alerts in Memory: $($Matching.Count)" -ForegroundColor Yellow
        $Matching | ForEach-Object {
            Write-Host "     - [$($_.labels.severity.ToUpper())] $($_.labels.alertname) | State: $($_.status.state)"
        }
    } else {
        Write-Host "  -> No active matching alerts found (alert resolved or expired)." -ForegroundColor Gray
    }
} catch {
    Write-Host "  -> [WARN] Could not retrieve active alert list: $($_.Exception.Message)" -ForegroundColor Yellow
}
