# D:\MusicDatasets\scripts\verify_pipeline_health.ps1
param(
    [string]$BaseDir = "D:\MusicDatasets"
)

$ErrorActionPreference = "Continue"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "       HYBRID 1.0 - AUTOMATED PIPELINE HEALTH & READINESS       " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Execution Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n"

$Results = @()

function Record-Check {
    param(
        [string]$Category,
        [string]$CheckItem,
        [string]$Status,
        [string]$Details
    )
    $script:Results += [PSCustomObject]@{
        Category = $Category
        Check    = $CheckItem
        Status   = $Status
        Details  = $Details
    }
}

function Test-PortListening {
    param(
        [string]$HostAddress = "127.0.0.1",
        [int]$Port,
        [int]$TimeoutMs = 1500
    )

    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect($HostAddress, $Port, $null, $null)
    $success = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)

    if ($success -and $client.Connected) {
        $client.EndConnect($iar)
        $client.Close()
        return $true
    } else {
        $client.Close()
        return $false
    }
}

# -------------------------------------------------------------------------
# 1. ENVIRONMENT VARIABLES
# -------------------------------------------------------------------------
$sbUrl = $env:SUPABASE_URL
$sbKey = $env:SUPABASE_SERVICE_ROLE_KEY

if ($sbUrl) {
    Record-Check "Environment" "SUPABASE_URL" "PASS" "Configured ($($sbUrl.Substring(0, [Math]::Min(25, $sbUrl.Length)))...)"
} else {
    Record-Check "Environment" "SUPABASE_URL" "FAIL" "Variable missing from system/user environment."
}

if ($sbKey) {
    Record-Check "Environment" "SUPABASE_SERVICE_ROLE_KEY" "PASS" "Key present ($($sbKey.Substring(0, [Math]::Min(12, $sbKey.Length)))...)"
} else {
    Record-Check "Environment" "SUPABASE_SERVICE_ROLE_KEY" "FAIL" "Variable missing from system/user environment."
}

# -------------------------------------------------------------------------
# 2. LOCAL DIRECTORY STRUCTURE
# -------------------------------------------------------------------------
$RequiredDirs = @(
    "$BaseDir\incoming",
    "$BaseDir\uploaded_slices",
    "$BaseDir\renders",
    "$BaseDir\archive",
    "$BaseDir\logs",
    "$BaseDir\scripts",
    "$BaseDir\config",
    "$BaseDir\monitoring\data"
)

foreach ($dir in $RequiredDirs) {
    if (Test-Path $dir) {
        Record-Check "Filesystem" $dir "PASS" "Directory exists."
    } else {
        Record-Check "Filesystem" $dir "FAIL" "Directory missing."
    }
}

# -------------------------------------------------------------------------
# 3. BINARIES & SYSTEM DEPENDENCIES
# -------------------------------------------------------------------------
$Dependencies = @("python", "ffmpeg", "nssm")

foreach ($dep in $Dependencies) {
    $cmd = Get-Command $dep -ErrorAction SilentlyContinue
    if ($cmd) {
        Record-Check "Dependencies" $dep "PASS" "Resolved at: $($cmd.Source)"
    } else {
        Record-Check "Dependencies" $dep "FAIL" "Binary not found in system PATH."
    }
}

# -------------------------------------------------------------------------
# 4. PYTHON & ORCHESTRATION SCRIPTS
# -------------------------------------------------------------------------
$Scripts = @(
    "watchdog_slicing_daemon.py",
    "daemon_poller.py",
    "ai_inference_engine.py",
    "cylinder_bus_summation.py",
    "hybrid_hex_pipeline_hook.py",
    "upload_master_to_cloud.py",
    "log_telemetry.py",
    "storage_guard_daemon.py",
    "prometheus_exporter.py",
    "run_master_pipeline.ps1",
    "tail_logs.ps1",
    "manage_alert_silences.ps1",
    "test_fire_alert.ps1"
)

foreach ($script in $Scripts) {
    $scriptPath = Join-Path "$BaseDir\scripts" $script
    if (Test-Path $scriptPath) {
        Record-Check "Pipeline Scripts" $script "PASS" "Found."
    } else {
        Record-Check "Pipeline Scripts" $script "FAIL" "Missing script file at $scriptPath"
    }
}

# -------------------------------------------------------------------------
# 5. WINDOWS NSSM DAEMON SERVICES
# -------------------------------------------------------------------------
$Services = @(
    "HybridWatchdogDaemon",
    "HybridAudioDaemon",
    "HybridStorageGuardDaemon",
    "HybridPrometheusExporterDaemon",
    "HybridPrometheusDaemon",
    "HybridAlertmanagerDaemon"
)

foreach ($svcName in $Services) {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -eq "Running") {
            Record-Check "Windows Services" $svcName "PASS" "Status: Running (StartType: $($svc.StartType))"
        } else {
            Record-Check "Windows Services" $svcName "WARN" "Installed but status is: $($svc.Status)"
        }
    } else {
        Record-Check "Windows Services" $svcName "FAIL" "Service not registered in Windows Service Manager."
    }
}

# -------------------------------------------------------------------------
# 6. ACTIVE NETWORK PORTS & ENDPOINTS
# -------------------------------------------------------------------------
$PortChecks = @(
    @{ Name = "Prometheus UI / Engine"; Port = 9090 },
    @{ Name = "Alertmanager Gateway";   Port = 9093 },
    @{ Name = "Hybrid Metrics Exporter"; Port = 9191 }
)

foreach ($endpoint in $PortChecks) {
    $isListening = Test-PortListening -Port $endpoint.Port
    if ($isListening) {
        Record-Check "Network Ports" "Port $($endpoint.Port) ($($endpoint.Name))" "PASS" "Socket active and accepting TCP connections."
    } else {
        Record-Check "Network Ports" "Port $($endpoint.Port) ($($endpoint.Name))" "FAIL" "Socket closed or service not listening on 127.0.0.1:$($endpoint.Port)."
    }
}

# -------------------------------------------------------------------------
# 7. HARDWARE & DISK METRICS
# -------------------------------------------------------------------------
$drive = Get-PSDrive -Name "D" -ErrorAction SilentlyContinue

if ($drive) {
    $freeGb = [math]::Round($drive.Free / 1GB, 2)
    $usedGb = [math]::Round($drive.Used / 1GB, 2)
    $totalGb = $freeGb + $usedGb
    $freePercent = [math]::Round(($freeGb / $totalGb) * 100, 1)

    if ($freePercent -lt 15) {
        Record-Check "Hardware" "D: Storage Capacity" "WARN" "$freeGb GB free (${freePercent}% capacity remaining)"
    } else {
        Record-Check "Hardware" "D: Storage Capacity" "PASS" "$freeGb GB free of $totalGb GB (${freePercent}% available)"
    }
} else {
    Record-Check "Hardware" "D: Drive Mount" "FAIL" "D: volume is not mounted or accessible."
}

# -------------------------------------------------------------------------
# 8. SUPABASE CLOUD CONNECTIVITY
# -------------------------------------------------------------------------
if ($sbUrl -and $sbKey) {
    try {
        $headers = @{
            "apikey"        = $sbKey
            "Authorization" = "Bearer $sbKey"
        }
        $endpoint = "$sbUrl/rest/v1/user_vaults?select=session_id&limit=1"
        $response = Invoke-RestMethod -Uri $endpoint -Headers $headers -Method Get -TimeoutSec 10
        Record-Check "Cloud Ledger" "Supabase Database" "PASS" "REST connection verified. 'user_vaults' accessible."
    } catch {
        Record-Check "Cloud Ledger" "Supabase Database" "FAIL" "Query failed: $($_.Exception.Message)"
    }

    try {
        $storageEndpoint = "$sbUrl/storage/v1/bucket/vault-storage"
        $storageRes = Invoke-RestMethod -Uri $storageEndpoint -Headers $headers -Method Get -TimeoutSec 10
        Record-Check "Cloud Storage" "Supabase Bucket" "PASS" "Bucket 'vault-storage' verified accessible."
    } catch {
        Record-Check "Cloud Storage" "Supabase Bucket" "WARN" "Bucket verification check returned: $($_.Exception.Message)"
    }
}

# -------------------------------------------------------------------------
# RENDER READINESS REPORT
# -------------------------------------------------------------------------
Write-Host "DIAGNOSTIC RESULTS:`n" -ForegroundColor Yellow

foreach ($item in $Results) {
    $color = switch ($item.Status) {
        "PASS" { [ConsoleColor]::Green }
        "WARN" { [ConsoleColor]::Yellow }
        "FAIL" { [ConsoleColor]::Red }
        Default { [ConsoleColor]::White }
    }

    $statusTag = "[$($item.Status)]".PadRight(8)
    $categoryTag = "$($item.Category)".PadRight(18)
    $checkTag = "$($item.Check)".PadRight(38)

    Write-Host "$statusTag $categoryTag $checkTag $($item.Details)" -ForegroundColor $color
}

$passCount = ($Results | Where-Object { $_.Status -eq "PASS" }).Count
$warnCount = ($Results | Where-Object { $_.Status -eq "WARN" }).Count
$failCount = ($Results | Where-Object { $_.Status -eq "FAIL" }).Count
$totalCount = $Results.Count

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "SUMMARY: $passCount/$totalCount Passed | $warnCount Warnings | $failCount Failures" -ForegroundColor $(if ($failCount -eq 0) { [ConsoleColor]::Green } else { [ConsoleColor]::Red })

if ($failCount -eq 0 -and $warnCount -eq 0) {
    Write-Host "OVERALL VERDICT: [READY] All workstation daemons, monitoring ports, and cloud subsystems are operational." -ForegroundColor Green
} elseif ($failCount -eq 0) {
    Write-Host "OVERALL VERDICT: [OPERATIONAL WITH WARNINGS] Review non-critical warnings above." -ForegroundColor Yellow
} else {
    Write-Host "OVERALL VERDICT: [ACTION REQUIRED] Resolve critical failures before triggering pipeline sessions." -ForegroundColor Red
}

Write-Host "================================================================" -ForegroundColor Cyan
