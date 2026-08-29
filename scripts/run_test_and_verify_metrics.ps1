# D:\MusicDatasets\scripts\run_test_and_verify_metrics.ps1
param(
    [switch]$SkipTest = $false
)

$ErrorActionPreference = "Continue"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - PIPELINE TRIGGER & METRICS VERIFICATION" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# Resolve a real interpreter: bare 'python' is the Store alias stub here.
. "$PSScriptRoot\resolve_python.ps1"
$Python = Get-HybridPython -Quiet

if (-not $Python) {
    Write-Host "[ERROR] No usable Python interpreter found." -ForegroundColor Red
    exit 1
}

# 1. Execute end-to-end integration test
if ($SkipTest) {
    Write-Host "`n[1/3] Pipeline test skipped (-SkipTest)." -ForegroundColor Gray
} else {
    Write-Host "`n[1/3] Executing pipeline test trigger..." -ForegroundColor Yellow
    $testScript = Join-Path $PSScriptRoot "test_pipeline_trigger.py"

    if (Test-Path $testScript) {
        & $Python $testScript
    } else {
        Write-Host "  [SKIP] test_pipeline_trigger.py not found." -ForegroundColor DarkGray
    }
}

# 2. Query Exporter Live Metrics on Port 9191
Write-Host "`n[2/3] Querying exporter scrape endpoint (http://127.0.0.1:9191/metrics)..." -ForegroundColor Yellow

try {
    $rawMetrics = (Invoke-WebRequest -Uri "http://127.0.0.1:9191/metrics" -UseBasicParsing -TimeoutSec 5).Content

    # Both session metric names are exported: hybrid_pipeline_sessions_total for
    # the workstation dashboard, hybrid_active_sessions for the observability one.
    $filtered = $rawMetrics -split "`n" | Where-Object {
        $_ -match "^hybrid_active_sessions" -or
        $_ -match "^hybrid_pipeline_sessions_total" -or
        $_ -match "^hybrid_stagnant_sessions_count" -or
        $_ -match "^hybrid_pipeline_autoheal_total" -or
        $_ -match "^hybrid_workstation_cpu_utilization_percent" -or
        $_ -match "^hybrid_workstation_disk_utilization_percent" -or
        $_ -match "^hybrid_pipeline_stage_duration_seconds" -or
        $_ -match '^node_filesystem_free_bytes\{mountpoint="D:"'
    }

    if ($filtered) {
        Write-Host "`n--- LIVE EXPORTER METRICS ---" -ForegroundColor Green
        $filtered | ForEach-Object { Write-Host "  $_" -ForegroundColor White }
    } else {
        Write-Host "  [WARN] Endpoint responded but none of the expected series were present." -ForegroundColor Yellow
        Write-Host "         The collector thread may not have completed its first 15s cycle." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [ERROR] Failed to query exporter on port 9191: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "          Is HybridPrometheusExporterDaemon running?" -ForegroundColor DarkYellow
}

# 3. Query Prometheus TSDB Engine on Port 9090
Write-Host "`n[3/3] Querying Prometheus TSDB API (http://127.0.0.1:9090/api/v1/query)..." -ForegroundColor Yellow

try {
    $sessionMetrics = Invoke-RestMethod -Uri "http://127.0.0.1:9090/api/v1/query?query=hybrid_pipeline_sessions_total" -TimeoutSec 5

    if ($sessionMetrics.data.result.Count -gt 0) {
        Write-Host "`n--- PROMETHEUS TSDB SESSION STATES ---" -ForegroundColor Green
        foreach ($res in $sessionMetrics.data.result) {
            $status = [string]$res.metric.status
            $val = $res.value[1]
            Write-Host "  - Status: $($status.PadRight(12)) Count: $val" -ForegroundColor White
        }
    } else {
        Write-Host "  [WARN] Query succeeded but returned no series. Prometheus may not have scraped yet." -ForegroundColor Yellow
    }

    # Stall count is what the healer alerts key off, so surface it explicitly
    $stall = Invoke-RestMethod -Uri "http://127.0.0.1:9090/api/v1/query?query=hybrid_stagnant_sessions_count" -TimeoutSec 5
    if ($stall.data.result.Count -gt 0) {
        Write-Host "  - Stagnant sessions: $($stall.data.result[0].value[1])" -ForegroundColor White
    }
} catch {
    Write-Host "  [WARN] Prometheus TSDB API unreachable on port 9090: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "VERIFICATION RUN COMPLETE" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
