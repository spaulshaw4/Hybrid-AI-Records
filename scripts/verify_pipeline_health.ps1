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
    # $(...) not ${...}: the latter treats its contents as a variable NAME, so
    # ${sbKey.Substring(...)} resolves to nothing and prints an empty prefix.
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
    "$BaseDir\archive\backups",
    "$BaseDir\logs",
    "$BaseDir\scripts",
    "$BaseDir\config",
    "$BaseDir\monitoring\data",
    "$BaseDir\monitoring\grafana\dashboards",
    "$BaseDir\monitoring\grafana\provisioning\dashboards",
    "$BaseDir\monitoring\grafana\provisioning\datasources"
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
. "$PSScriptRoot\resolve_python.ps1"

# Python needs the resolver, not Get-Command: PATH resolves to the WindowsApps
# App Execution Alias stub on this machine, which is not an interpreter and
# would report a false PASS while every daemon dies on start.
$resolvedPython = Get-HybridPython -Quiet

if ($resolvedPython) {
    $pyVersion = (& $resolvedPython --version 2>&1)
    $pathStub = (Get-Command python -ErrorAction SilentlyContinue).Source

    if ($pathStub -like "*\WindowsApps\*") {
        Record-Check "Dependencies" "python" "WARN" "$pyVersion at $resolvedPython, but PATH resolves to the Store stub ($pathStub). Scripts using bare 'python' will fail."
    } else {
        Record-Check "Dependencies" "python" "PASS" "$pyVersion at $resolvedPython"
    }
} else {
    Record-Check "Dependencies" "python" "FAIL" "No real interpreter found. PATH may only contain the WindowsApps alias stub."
}

foreach ($dep in @("ffmpeg", "nssm")) {
    $cmd = Get-Command $dep -ErrorAction SilentlyContinue
    if ($cmd) {
        Record-Check "Dependencies" $dep "PASS" "Resolved at: $($cmd.Source)"
    } else {
        Record-Check "Dependencies" $dep "FAIL" "Binary not found in system PATH."
    }
}

# Packages every daemon imports at module scope
if ($resolvedPython) {
    foreach ($pkg in @("supabase", "pydub", "psutil", "watchdog", "numpy", "prometheus_client")) {
        & $resolvedPython -c "import $pkg" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Record-Check "Python Packages" $pkg "PASS" "Importable."
        } else {
            Record-Check "Python Packages" $pkg "FAIL" "Not installed for $resolvedPython"
        }
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
    "pipeline_stagnation_healer.py",
    "prometheus_exporter.py",
    "replay_database_snapshots.py",
    "build_genre_corpus.py",
    "genre_resolver.py",
    "resolve_python.ps1",
    "run_master_pipeline.ps1",
    "manage_all_services.ps1",
    "tail_logs.ps1",
    "backup_disaster_recovery.ps1",
    "restore_disaster_recovery.ps1",
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
# 5. GRAFANA PROVISIONING & DASHBOARD ASSETS
# -------------------------------------------------------------------------
$ProvisioningFiles = @(
    @{ Name = "Dashboard Provider YAML";   Path = "$BaseDir\monitoring\grafana\provisioning\dashboards\hybrid_dashboards.yml" },
    @{ Name = "Data Source Provider YAML"; Path = "$BaseDir\monitoring\grafana\provisioning\datasources\hybrid_datasources.yml" }
)

foreach ($prov in $ProvisioningFiles) {
    if (Test-Path $prov.Path) {
        $fileSizeKb = [math]::Round((Get-Item $prov.Path).Length / 1KB, 1)
        Record-Check "Grafana Assets" $prov.Name "PASS" "Present (${fileSizeKb} KB)"
    } else {
        Record-Check "Grafana Assets" $prov.Name "FAIL" "File missing at $($prov.Path)"
    }
}

# Checked by pattern rather than a fixed filename: the repo ships
# hybrid_workstation_dashboard.json and hybrid_observability_dashboard.json.
$dashDir = "$BaseDir\monitoring\grafana\dashboards"
$dashFiles = @(Get-ChildItem -Path $dashDir -Filter "*.json" -File -ErrorAction SilentlyContinue)

if ($dashFiles.Count -gt 0) {
    $validCount = 0
    foreach ($f in $dashFiles) {
        try {
            Get-Content $f.FullName -Raw | ConvertFrom-Json | Out-Null
            $validCount++
        } catch { }
    }
    if ($validCount -eq $dashFiles.Count) {
        Record-Check "Grafana Assets" "Dashboard JSON" "PASS" "$validCount valid dashboard(s) in $dashDir"
    } else {
        Record-Check "Grafana Assets" "Dashboard JSON" "WARN" "$validCount of $($dashFiles.Count) parse as valid JSON"
    }
} else {
    Record-Check "Grafana Assets" "Dashboard JSON" "FAIL" "No dashboard JSON in $dashDir"
}

# -------------------------------------------------------------------------
# 6. WINDOWS NSSM DAEMON SERVICES (7 CORE SERVICES)
# -------------------------------------------------------------------------
$Services = @(
    "HybridPrometheusExporterDaemon",
    "HybridPrometheusDaemon",
    "HybridAlertmanagerDaemon",
    "HybridStorageGuardDaemon",
    "HybridStagnationHealerDaemon",
    "HybridWatchdogDaemon",
    "HybridAudioDaemon"
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

# Grafana may run as a service or as a standalone binary; absence is not a fault.
$grafanaSvc = Get-Service -Name "grafana" -ErrorAction SilentlyContinue
if (-not $grafanaSvc) { $grafanaSvc = Get-Service -Name "Grafana" -ErrorAction SilentlyContinue }

if ($grafanaSvc) {
    if ($grafanaSvc.Status -eq "Running") {
        Record-Check "Windows Services" "GrafanaService" "PASS" "Status: Running"
    } else {
        Record-Check "Windows Services" "GrafanaService" "WARN" "Installed but status is: $($grafanaSvc.Status)"
    }
} else {
    Record-Check "Windows Services" "GrafanaService" "INFO" "Not registered as Windows service (standalone binary mode)"
}

# -------------------------------------------------------------------------
# 7. ACTIVE NETWORK PORTS & ENDPOINTS
# -------------------------------------------------------------------------
$PortChecks = @(
    @{ Name = "Prometheus UI / Engine"; Port = 9090 },
    @{ Name = "Alertmanager Gateway";   Port = 9093 },
    @{ Name = "Hybrid Metrics Exporter"; Port = 9191 },
    @{ Name = "Grafana Observability UI"; Port = 3000 }
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
# 8. GENRE CORPUS READINESS
# -------------------------------------------------------------------------
$genreResolver = Join-Path "$BaseDir\scripts" "genre_resolver.py"
$slicesRoot = Join-Path $BaseDir "uploaded_slices"

if ($resolvedPython -and (Test-Path $genreResolver) -and (Test-Path $slicesRoot)) {
    $listing = & $resolvedPython $genreResolver --list-available --slices-dir $slicesRoot 2>$null
    $summary = $listing | Select-String -Pattern "genres present" | Select-Object -First 1

    if ($summary) {
        Record-Check "Genre Corpus" "Staged genres" "PASS" ($summary.Line.Trim())
    } else {
        Record-Check "Genre Corpus" "Staged genres" "WARN" "No genres staged in uploaded_slices yet."
    }
} else {
    Record-Check "Genre Corpus" "Staged genres" "WARN" "Cannot evaluate: resolver or uploaded_slices not present."
}

# -------------------------------------------------------------------------
# 9. SUPABASE CLOUD CONNECTIVITY
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
        $slicesEndpoint = "$sbUrl/rest/v1/audio_slices?select=filename&limit=1"
        $slicesRes = Invoke-RestMethod -Uri $slicesEndpoint -Headers $headers -Method Get -TimeoutSec 10
        Record-Check "Cloud Ledger" "audio_slices table" "PASS" "Slice ledger accessible."
    } catch {
        Record-Check "Cloud Ledger" "audio_slices table" "FAIL" "Query failed: $($_.Exception.Message)"
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
        "INFO" { [ConsoleColor]::DarkGray }
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
    Write-Host "OVERALL VERDICT: [READY] All 7 workstation daemons, monitoring ports, and cloud subsystems are operational." -ForegroundColor Green
} elseif ($failCount -eq 0) {
    Write-Host "OVERALL VERDICT: [OPERATIONAL WITH WARNINGS] Review non-critical warnings above." -ForegroundColor Yellow
} else {
    Write-Host "OVERALL VERDICT: [ACTION REQUIRED] Resolve critical failures before triggering pipeline sessions." -ForegroundColor Red
}

Write-Host "================================================================" -ForegroundColor Cyan
