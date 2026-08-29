<#
.SYNOPSIS
    Syncs Hybrid 1.0 pipeline scripts from the git repo to the D: workstation.
.DESCRIPTION
    The repo is the source of truth. Every pipeline script references absolute
    paths under D:\MusicDatasets\scripts, so this copies the current repo state
    there and creates the directory scaffold the daemons expect.

    Genre subfolders under incoming\ and uploaded_slices\ are intentionally not
    created - watchdog_slicing_daemon.py creates them on demand from the parent
    folder name of each ingested file.
.PARAMETER SourceDir
    Repo scripts directory. Defaults to the folder containing this script.
.PARAMETER BaseDir
    Workstation root. Defaults to D:\MusicDatasets.
.PARAMETER DryRun
    Report what would change without writing anything.
.EXAMPLE
    .\deploy_to_workstation.ps1 -DryRun
    .\deploy_to_workstation.ps1
#>

param(
    [string]$SourceDir = $PSScriptRoot,
    [string]$BaseDir = "D:\MusicDatasets",
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"

$TargetDir = Join-Path $BaseDir "scripts"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - WORKSTATION DEPLOYMENT SYNC" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Source : $SourceDir"
Write-Host "Target : $TargetDir"
Write-Host "Mode   : $(if ($DryRun) { '[DRY RUN - NO WRITES]' } else { '[LIVE SYNC]' })"
Write-Host "================================================================" -ForegroundColor Cyan

if (!(Test-Path $SourceDir)) {
    throw "Source directory not found: $SourceDir"
}

# Refuse to run when deployed copy is used as its own source
$resolvedSource = (Resolve-Path $SourceDir).Path.TrimEnd('\')
if ((Test-Path $TargetDir) -and $resolvedSource -eq (Resolve-Path $TargetDir).Path.TrimEnd('\')) {
    throw "Source and target are the same directory. Run this from the repo copy, not from $TargetDir."
}

# -------------------------------------------------------------------------
# 1. Directory scaffold
# -------------------------------------------------------------------------
$RequiredDirs = @(
    (Join-Path $BaseDir "incoming"),
    (Join-Path $BaseDir "uploaded_slices"),
    (Join-Path $BaseDir "renders"),
    (Join-Path $BaseDir "archive"),
    # backup_disaster_recovery.ps1 creates this on demand, but
    # verify_pipeline_health.ps1 checks for it, so create it up front.
    (Join-Path $BaseDir "archive\backups"),
    (Join-Path $BaseDir "logs"),
    (Join-Path $BaseDir "config"),
    # Prometheus and Alertmanager TSDB paths, created by
    # register_monitoring_services.ps1 but checked by the health script.
    (Join-Path $BaseDir "monitoring\data\prometheus"),
    (Join-Path $BaseDir "monitoring\data\alertmanager"),
    $TargetDir
)

Write-Host "`nDIRECTORY SCAFFOLD:" -ForegroundColor Yellow
foreach ($dir in $RequiredDirs) {
    if (Test-Path $dir) {
        Write-Host "  [EXISTS] $dir" -ForegroundColor Gray
    } else {
        Write-Host "  [CREATE] $dir" -ForegroundColor Green
        if (-not $DryRun) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
        }
    }
}

# -------------------------------------------------------------------------
# 2. Script sync
# -------------------------------------------------------------------------
# Explicit manifest. The repo scripts/ folder also holds a large amount of
# unrelated legacy tooling, so a wildcard sync would copy ~75 files the
# pipeline never calls. Add new pipeline scripts here deliberately.
$Manifest = @(
    # Shared helpers (dot-sourced by other scripts - must deploy first)
    "resolve_python.ps1",

    # Dataset acquisition and unpacking
    "fetch_dataset_binary.ps1",
    "bulk_extract_datasets.ps1",

    # Genre labelling and resolution
    "build_genre_corpus.py",
    "genre_resolver.py",

    # Ingestion
    "watchdog_slicing_daemon.py",
    "local_slicer.py",
    "batch_slicer_upload.py",

    # Orchestration
    "daemon_poller.py",
    "run_master_pipeline.ps1",
    "cylinder_orchestrator.py",

    # Render chain
    "ai_inference_engine.py",
    "hybrid_dsp.py",
    "genre_quadrant_engine.py",
    "alertmanager_bridge.py",
    "install_binary_dependencies.ps1",
    "run_test_and_verify_metrics.ps1",
    "audio_qc_analyzer.py",
    "validate_audio_stems.py",
    "hardware_macro_server.py",
    "hybrid_terminal_hud.py",
    "test_genre_quadrants_suite.py",
    "track_constructor_engine.py",
    "test_track_constructor.py",
    "build_stem_registry.py",
    "test_frame_alignment.py",
    "test_subdivision_alignment.py",
    "test_stem_registry.py",
    "test_euclidean_patterns.py",
    "cylinder_premix_overlay.py",
    "cylinder_bus_summation.py",
    "hybrid_hex_pipeline_hook.py",
    "upload_master_to_cloud.py",

    # Observability
    "log_telemetry.py",
    "analyze_telemetry_performance.py",
    "prometheus_exporter.py",
    "telemetry_monitor.py",
    "tail_logs.ps1",

    # Self-healing
    "pipeline_stagnation_healer.py",
    "register_stagnation_healer_service.ps1",

    # Storage management
    "storage_guard_daemon.py",
    "reclaim_render_storage.ps1",
    "egress_protection.py",

    # Backup and disaster recovery
    "backup_disaster_recovery.ps1",
    "restore_disaster_recovery.ps1",
    "replay_database_snapshots.py",
    "register_backup_task.ps1",

    # Model training
    "ai_feature_learner.py",
    "ai_model_trainer.py",

    # Service registration
    "nssm_daemon_setup.ps1",
    "nssm_watchdog_setup.ps1",
    "register_prometheus_exporter_service.ps1",
    "register_monitoring_services.ps1",
    "verify_and_run_alertmanager.ps1",
    "configure_nssm_logging.ps1",
    "manage_all_services.ps1",

    # Orchestration entry points
    "register_all_services.ps1",
    "bootstrap_master_suite.ps1",

    # Operator UI
    "hybrid_control_center.bat",
    "setup_desktop_shortcuts.ps1",
    "setup_grafana_provisioning.ps1",
    "reload_prometheus_config.ps1",
    "test_stagnation_healer.py",
    "hybrid_tray_app.py",
    "install_tray_startup.ps1",
    "restart_tray_app.ps1",

    # Diagnostics and test harnesses
    "verify_pipeline_health.ps1",
    "health_check.py",
    "admin_dashboard.py",
    "test_pipeline_trigger.py",
    "dispatch_test_session.py",
    "create_mock_session.py",
    "test_fire_alert.ps1",
    "manage_alert_silences.ps1"
)

$sourceFiles = @()
$missingFromRepo = @()

foreach ($name in $Manifest) {
    $candidate = Join-Path $SourceDir $name
    if (Test-Path $candidate) {
        $sourceFiles += Get-Item $candidate
    } else {
        $missingFromRepo += $name
    }
}

if ($missingFromRepo.Count -gt 0) {
    Write-Host "`n[WARN] Manifest entries not found in source directory:" -ForegroundColor Yellow
    foreach ($name in $missingFromRepo) {
        Write-Host "  [ABSENT]  $name" -ForegroundColor DarkYellow
    }
}

Write-Host "`nSCRIPT SYNC ($($sourceFiles.Count) of $($Manifest.Count) manifest files present):" -ForegroundColor Yellow

$newCount = 0
$updatedCount = 0
$unchangedCount = 0

foreach ($file in $sourceFiles) {
    $destPath = Join-Path $TargetDir $file.Name

    if (-not (Test-Path $destPath)) {
        Write-Host "  [NEW]     $($file.Name)" -ForegroundColor Green
        if (-not $DryRun) { Copy-Item -Path $file.FullName -Destination $destPath -Force }
        $newCount++
        continue
    }

    $srcHash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -Path $destPath -Algorithm SHA256).Hash

    if ($srcHash -ne $dstHash) {
        Write-Host "  [UPDATED] $($file.Name)" -ForegroundColor Cyan
        if (-not $DryRun) { Copy-Item -Path $file.FullName -Destination $destPath -Force }
        $updatedCount++
    } else {
        $unchangedCount++
    }
}

# -------------------------------------------------------------------------
# 3. Monitoring config sync (repo monitoring\*.yml -> BaseDir\config)
#     prometheus.yml references D:/MusicDatasets/config/alerts.yml, and
#     alertmanager.yml is loaded from the same folder, so both must land here
#     or Prometheus refuses to start on a missing rule file.
# -------------------------------------------------------------------------
$RepoRoot = Split-Path $SourceDir -Parent
$MonitoringDir = Join-Path $RepoRoot "monitoring"
$ConfigTarget = Join-Path $BaseDir "config"

$configNew = 0
$configUpdated = 0
$configUnchanged = 0

if (Test-Path $MonitoringDir) {
    $configFiles = Get-ChildItem -Path (Join-Path $MonitoringDir "*") -File |
        Where-Object { $_.Extension -in @(".yml", ".yaml") }

    Write-Host "`nMONITORING CONFIG SYNC ($($configFiles.Count) files -> $ConfigTarget):" -ForegroundColor Yellow

    foreach ($file in $configFiles) {
        $destPath = Join-Path $ConfigTarget $file.Name

        if (-not (Test-Path $destPath)) {
            Write-Host "  [NEW]     $($file.Name)" -ForegroundColor Green
            if (-not $DryRun) { Copy-Item -Path $file.FullName -Destination $destPath -Force }
            $configNew++
            continue
        }

        $srcHash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash
        $dstHash = (Get-FileHash -Path $destPath -Algorithm SHA256).Hash

        if ($srcHash -ne $dstHash) {
            Write-Host "  [UPDATED] $($file.Name)" -ForegroundColor Cyan
            if (-not $DryRun) { Copy-Item -Path $file.FullName -Destination $destPath -Force }
            $configUpdated++
        } else {
            $configUnchanged++
        }
    }
} else {
    Write-Host "`n[WARN] Monitoring directory not found at $MonitoringDir - skipping config sync." -ForegroundColor Yellow
}

# -------------------------------------------------------------------------
# 3b. Grafana tree sync
#     hybrid_dashboards.yml declares options.path as
#     D:\MusicDatasets\monitoring\grafana\dashboards, so the JSON must land
#     there specifically - the config sync above only handles *.yml into config\.
# -------------------------------------------------------------------------
$GrafanaSrc = Join-Path $MonitoringDir "grafana"

if (Test-Path $GrafanaSrc) {
    $grafanaTargets = @{
        (Join-Path $GrafanaSrc "*.json")                        = (Join-Path $BaseDir "monitoring\grafana\dashboards")
        (Join-Path $GrafanaSrc "provisioning\dashboards\*.yml") = (Join-Path $BaseDir "monitoring\grafana\provisioning\dashboards")
        (Join-Path $GrafanaSrc "provisioning\datasources\*.yml")= (Join-Path $BaseDir "monitoring\grafana\provisioning\datasources")
    }

    Write-Host "`nGRAFANA SYNC:" -ForegroundColor Yellow

    foreach ($pattern in $grafanaTargets.Keys) {
        $dest = $grafanaTargets[$pattern]
        $files = @(Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue)

        if ($files.Count -eq 0) { continue }

        if (-not $DryRun -and -not (Test-Path $dest)) {
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
        }

        foreach ($file in $files) {
            $destPath = Join-Path $dest $file.Name
            $label = "UPDATED"

            if (-not (Test-Path $destPath)) {
                $label = "NEW"
            } elseif ((Get-FileHash $file.FullName).Hash -eq (Get-FileHash $destPath).Hash) {
                continue
            }

            Write-Host "  [$label] $($file.Name) -> $dest" -ForegroundColor Cyan
            if (-not $DryRun) { Copy-Item -Path $file.FullName -Destination $destPath -Force }
        }
    }
} else {
    Write-Host "`n[WARN] No grafana directory under $MonitoringDir - skipping dashboard sync." -ForegroundColor Yellow
}

# -------------------------------------------------------------------------
# 4. Orphan detection (present on D: but no longer in the repo)
# -------------------------------------------------------------------------
$orphans = @()
if (Test-Path $TargetDir) {
    $sourceNames = $sourceFiles | ForEach-Object { $_.Name }
    $orphans = Get-ChildItem -Path $TargetDir -File |
        Where-Object { $_.Extension -in @(".py", ".ps1") -and $sourceNames -notcontains $_.Name }
}

if ($orphans.Count -gt 0) {
    Write-Host "`nORPHANED FILES ON TARGET (not deleted - review manually):" -ForegroundColor Yellow
    foreach ($orphan in $orphans) {
        Write-Host "  [ORPHAN]  $($orphan.Name)" -ForegroundColor DarkYellow
    }
}

# -------------------------------------------------------------------------
# 4. Environment readiness
# -------------------------------------------------------------------------
Write-Host "`nENVIRONMENT READINESS:" -ForegroundColor Yellow

$envOk = $true
foreach ($varName in @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    $value = [Environment]::GetEnvironmentVariable($varName)
    if ($value) {
        Write-Host "  [OK]      $varName is set" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $varName" -ForegroundColor Red
        $envOk = $false
    }
}

# Python is checked via the resolver, not Get-Command: PATH usually resolves to
# the WindowsApps App Execution Alias stub, which is not an interpreter.
. "$SourceDir\resolve_python.ps1"
$resolvedPython = Get-HybridPython -Quiet

if ($resolvedPython) {
    Write-Host "  [OK]      python $((& $resolvedPython --version 2>&1) -replace 'Python\s*','') at $resolvedPython" -ForegroundColor Green

    foreach ($pkg in @("supabase", "pydub", "psutil", "watchdog", "numpy")) {
        & $resolvedPython -c "import $pkg" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [OK]      python package: $pkg" -ForegroundColor Green
        } else {
            Write-Host "  [MISSING] python package: $pkg" -ForegroundColor Red
            $envOk = $false
        }
    }
} else {
    Write-Host "  [MISSING] python (no real interpreter; PATH may only hold the Store stub)" -ForegroundColor Red
    $envOk = $false
}

foreach ($dep in @("ffmpeg", "nssm")) {
    if (Get-Command $dep -ErrorAction SilentlyContinue) {
        Write-Host "  [OK]      $dep resolved in PATH" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $dep not in PATH" -ForegroundColor Red
    }
}

# -------------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------------
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "SYNC SUMMARY: $newCount new | $updatedCount updated | $unchangedCount unchanged | $($orphans.Count) orphaned"

if ($DryRun) {
    Write-Host "Dry run complete - no files were written. Re-run without -DryRun to apply." -ForegroundColor Yellow
} elseif (-not $envOk) {
    Write-Host "Scripts deployed, but Supabase credentials are missing. Set them before starting daemons." -ForegroundColor Yellow
} else {
    Write-Host "Workstation is synced and ready." -ForegroundColor Green
}
Write-Host "================================================================" -ForegroundColor Cyan
