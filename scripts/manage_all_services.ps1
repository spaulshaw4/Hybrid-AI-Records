# D:\MusicDatasets\scripts\manage_all_services.ps1
param(
    [ValidateSet("start", "stop", "restart", "status")]
    [string]$Action = "restart"
)

$ErrorActionPreference = "Continue"

# Ensure script is running with elevated administrative permissions
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)
$IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $IsAdmin) {
    Write-Host "[ERROR] Administrator privileges required to manage Windows services." -ForegroundColor Red
    Write-Host "Please re-run this script in an elevated PowerShell window." -ForegroundColor Yellow
    exit 1
}

# The core Hybrid 1.0 daemon services in dependency-safe startup order.
# The healer starts after the audio daemon: it re-queues sessions the pipeline
# abandoned, so the worker that consumes them should already be up.
$Services = @(
    "HybridPrometheusExporterDaemon",
    "HybridPrometheusDaemon",
    "HybridAlertmanagerDaemon",
    "HybridAlertBridgeDaemon",
    "HybridHardwareMacroDaemon",
    "HybridStorageGuardDaemon",
    "HybridWatchdogDaemon",
    "HybridAudioDaemon",
    "HybridStagnationHealerDaemon"
)

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - SERVICE CONTROLLER" -ForegroundColor Cyan
Write-Host "Target Action : $($Action.ToUpper())"
Write-Host "Total Daemons : $($Services.Count) Registered Services"
Write-Host "Execution Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "================================================================" -ForegroundColor Cyan

function Execute-ServiceAction {
    param(
        [string]$Name,
        [string]$Op
    )

    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue

    if (-not $svc) {
        Write-Host "  [$Name] -> Service not installed/registered." -ForegroundColor Red
        return
    }

    try {
        switch ($Op) {
            "start" {
                if ($svc.Status -eq "Running") {
                    Write-Host "  [$Name] -> Already running." -ForegroundColor Gray
                } else {
                    Write-Host "  [$Name] -> Starting service..." -ForegroundColor Yellow
                    Start-Service -Name $Name -ErrorAction Stop
                    Write-Host "  [$Name] -> Running." -ForegroundColor Green
                }
            }
            "stop" {
                if ($svc.Status -eq "Stopped") {
                    Write-Host "  [$Name] -> Already stopped." -ForegroundColor Gray
                } else {
                    Write-Host "  [$Name] -> Stopping service..." -ForegroundColor Yellow
                    Stop-Service -Name $Name -Force -ErrorAction Stop
                    Write-Host "  [$Name] -> Stopped." -ForegroundColor Green
                }
            }
            "restart" {
                Write-Host "  [$Name] -> Restarting service..." -ForegroundColor Yellow
                Restart-Service -Name $Name -Force -ErrorAction Stop
                Write-Host "  [$Name] -> Restarted successfully." -ForegroundColor Green
            }
            "status" {
                # Status handled in table render
            }
        }
    } catch {
        Write-Host "  [$Name] -> Failed to execute $Op : $($_.Exception.Message)" -ForegroundColor Red
    }
}

# Determine sequence order: shutdown in reverse order, boot in forward order
$TargetOrder = if ($Action -eq "stop") {
    $reversed = $Services.Clone()
    [Array]::Reverse($reversed)
    $reversed
} else {
    $Services
}

# Execute operation across services
if ($Action -ne "status") {
    foreach ($svcName in $TargetOrder) {
        Execute-ServiceAction -Name $svcName -Op $Action
    }

    # Allow services a moment to settle state
    Start-Sleep -Seconds 2
}

# Display final status table
Write-Host "`nCURRENT DAEMON SERVICE STATUS:" -ForegroundColor Yellow

$StatusReports = foreach ($svcName in $Services) {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svc) {
        [PSCustomObject]@{
            ServiceName = $svc.Name
            DisplayName = $svc.DisplayName
            Status      = $svc.Status
            StartType   = $svc.StartType
        }
    } else {
        [PSCustomObject]@{
            ServiceName = $svcName
            DisplayName = "Not Found"
            Status      = "UNREGISTERED"
            StartType   = "N/A"
        }
    }
}

$StatusReports | Format-Table -AutoSize

$runningCount = ($StatusReports | Where-Object { $_.Status -eq "Running" }).Count
$totalCount = $Services.Count

Write-Host "================================================================" -ForegroundColor Cyan
if ($runningCount -eq $totalCount) {
    Write-Host "ALL DAEMONS OPERATIONAL: $runningCount/$totalCount services active." -ForegroundColor Green
} else {
    Write-Host "STATUS NOTICE: $runningCount/$totalCount services currently running." -ForegroundColor $(if ($Action -eq "stop") { [ConsoleColor]::Gray } else { [ConsoleColor]::Yellow })
}
Write-Host "================================================================" -ForegroundColor Cyan
