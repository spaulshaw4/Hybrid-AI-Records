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
    (Join-Path $BaseDir "incoming_zips"),
    (Join-Path $BaseDir "oneshots"),
    (Join-Path $BaseDir "oneshots\kick"),
    (Join-Path $BaseDir "oneshots\snare"),
    (Join-Path $BaseDir "oneshots\hat"),
    (Join-Path $BaseDir "oneshots\perc"),
    (Join-Path $BaseDir "oneshots\fx"),
    (Join-Path $BaseDir "oneshots\other"),
    (Join-Path $BaseDir "raw_packs"),
    (Join-Path $BaseDir "incoming_stems"),
    (Join-Path $BaseDir "incoming_stems\_processed"),
    (Join-Path $BaseDir "incoming_stems\_failed"),
    (Join-Path $BaseDir "scratch\uploads"),
    (Join-Path $BaseDir "uploaded_slices"),
    (Join-Path $BaseDir "renders"),
    (Join-Path $BaseDir "archive"),
    # backup_disaster_recovery.ps1 creates this on demand, but
    # verify_pipeline_health.ps1 checks for it, so create it up front.
    (Join-Path $BaseDir "archive\backups"),
    (Join-Path $BaseDir "logs"),
    (Join-Path $BaseDir "config"),
    (Join-Path $BaseDir "engine"),
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
    "run_production_pipeline.ps1",
    "batch_album_generator.ps1",
    "deploy_production_release.ps1",
    "maintenance_cleanup.ps1",
    "batch_reslice_corpus.py",
    "resilient_corpus_slicer.py",
    "generic_slice_stager.py",
    "run_slicing_campaign.py",
    "run_slicing_campaign.ps1",
    "slicing_campaign_ledger.py",
    "qc_master_gate.py",
    "cylinder_orchestrator.py",

    # Render chain
    "ai_inference_engine.py",
    "hybrid_dsp.py",
    "hybrid_env.py",
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
    "atomic_rhythm_display_engine.py",
    "geometric_pattern_matrix_engine.py",
    "test_saturation_harmonics.py",
    "test_genre_compliance.py",
    "test_crest_and_dc.py",
    "test_plr_gate.py",
    "test_lufs_approximation.py",
    "enterprise_catalog_packager.py",
    "cylinder_premix_overlay.py",
    "cylinder_bus_summation.py",
    "hybrid_hex_pipeline_hook.py",
    "upload_master_to_cloud.py",
    "s3_storage_lifecycle.py",
    "apply_s3_lifecycle.py",
    "benchmark_master_engine.py",
    "verify_master_compliance.py",

    # Headless / prompt-driven generation entry points
    "arrange_from_prompt.py",
    "generate_from_prompt.ps1",
    "start_engine_headless.ps1",
    "test_local_engine.ps1",

    # Observability
    "log_telemetry.py",
    "analyze_telemetry_performance.py",
    "prometheus_exporter.py",
    "telemetry_monitor.py",
    "start_metrics_exporters.ps1",
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
    "backup_ledger_to_s3.py",
    "credit_user_token.py",
    "debit_user_token.py",
    "queue_master_session.py",
    "read_session_status.py",
    "read_meter_snapshot.py",
    "read_user_tokens.py",
    "corpus_sync_daemon.py",
    "ledger_schema.py",
    "sync_master_ledger.py",
    "init_master_schema.py",
    "read_system_health.py",
    "master_queue_worker.py",
    "stem_preflight.py",
    "calibrate_genre_target.py",
    "audio_metadata_tagger.py",
    "export_distribution_manifest.py",
    "s3_multipart_uploader.py",
    "stem_mix_balancer.py",
    "purge_cdn_cache.py",
    "db_sentinel.py",
    "generate_cue_sheet.py",
    "emergency_rollback.ps1",
    "catalog_migration_importer.py",
    "hardware_thermal_guard.py",
    "multi_format_encoder.py",
    "build_genre_matrix.py",
    "generate_waveform_peaks.py",
    "build_release_package.py",
    "sync_release_distro.py",
    "log_rotation_guard.py",
    "check_s3_vault.py",
    "check_sqlite_wal.py",
    "verify_system_readiness.ps1",
    "ingest_all_unzipped.ps1",
    "ingest_landr_packs.ps1",
    "auto_unzip_purge_and_index.ps1",
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
    "install_headless_service.ps1",

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
    "test_pipeline_e2e.ps1",
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

$dspNames = @(
    "true_peak_limiter.py",
    "loudness_meter.py",
    "midside_processor.py",
    "dynamic_eq_processor.py",
    "transient_shaper.py",
    "pitch_key_aligner.py",
    "tempo_time_stretch.py",
    "tape_saturation.py",
    "phase_aligner.py",
    "harmonic_exciter.py",
    "stereo_widener.py",
    "sub_harmonic_synth.py",
    "polarity_inverter_check.py",
    "tpdf_dither.py",
    "micro_crossfader.py",
    "smart_transient_slicer.py",
    "vocal_pitch_corrector.py",
    "qc_metric_validator.py",
    "stem_sidechain_glue.py",
    "__init__.py"
)
$DspTarget = Join-Path $BaseDir "dsp"
foreach ($dspName in $dspNames) {
    $dspFile = Join-Path (Split-Path $SourceDir -Parent) "dsp\$dspName"
    if (Test-Path $dspFile) {
        $sourceFiles += Get-Item $dspFile
        if (-not $DryRun) {
            if (-not (Test-Path $DspTarget)) {
                New-Item -ItemType Directory -Force -Path $DspTarget | Out-Null
            }
            Copy-Item -Path $dspFile -Destination (Join-Path $DspTarget $dspName) -Force
        }
    }
}

# Extra-copy engine modules next to the workstation corpus (not into scripts\).
$engineNames = @(
    "blueprint_track_assembler.py",
    "stem_role_router.py",
    "blueprint_schema.py",
    "gemini_arranger.py",
    "generate_track_headless.py",
    "smart_transient_slicer.py",
    "slice_rotator.py",
    "local_track_synthesizer.py",
    "release_packager.py",
    "metadata_tagger.py",
    "video_visualizer_generator.py",
    "neural_vocal_pipeline.py",
    "distro_bundle_packager.py"
)
$EngineTarget = Join-Path $BaseDir "engine"
$engineCopied = 0
Write-Host "`nENGINE SYNC -> $EngineTarget" -ForegroundColor Yellow
foreach ($engineName in $engineNames) {
    $engineFile = Join-Path (Split-Path $SourceDir -Parent) "engine\$engineName"
    if (-not (Test-Path $engineFile)) {
        Write-Host "  [ABSENT]  $engineName" -ForegroundColor DarkYellow
        continue
    }
    if (-not $DryRun) {
        if (-not (Test-Path $EngineTarget)) {
            New-Item -ItemType Directory -Force -Path $EngineTarget | Out-Null
        }
        Copy-Item -Path $engineFile -Destination (Join-Path $EngineTarget $engineName) -Force
    }
    Write-Host "  [ENGINE]  $engineName" -ForegroundColor Cyan
    $engineCopied++
}

# Extra-copy corpus indexer modules next to the workstation database (not into scripts\).
$dbNames = @(
    "index_578gb_corpus.py",
    "sample_indexer.py",
    "pack_tracker.py",
    "catalog_syncer.py",
    "__init__.py"
)
$DbTarget = Join-Path $BaseDir "db"
$dbCopied = 0
Write-Host "`nDB SYNC -> $DbTarget" -ForegroundColor Yellow
foreach ($dbName in $dbNames) {
    $dbFile = Join-Path (Split-Path $SourceDir -Parent) "db\$dbName"
    if (-not (Test-Path $dbFile)) {
        Write-Host "  [ABSENT]  $dbName" -ForegroundColor DarkYellow
        continue
    }
    if (-not $DryRun) {
        if (-not (Test-Path $DbTarget)) {
            New-Item -ItemType Directory -Force -Path $DbTarget | Out-Null
        }
        Copy-Item -Path $dbFile -Destination (Join-Path $DbTarget $dbName) -Force
    }
    Write-Host "  [DB]      $dbName" -ForegroundColor Cyan
    $dbCopied++
}

# Extra-copy headless API daemon next to the workstation corpus (not into scripts\).
$apiNames = @("headless_job_runner.py")
$ApiTarget = Join-Path $BaseDir "api"
$apiCopied = 0
Write-Host "`nAPI SYNC -> $ApiTarget" -ForegroundColor Yellow
foreach ($apiName in $apiNames) {
    $apiFile = Join-Path (Split-Path $SourceDir -Parent) "api\$apiName"
    if (-not (Test-Path $apiFile)) {
        Write-Host "  [ABSENT]  $apiName" -ForegroundColor DarkYellow
        continue
    }
    if (-not $DryRun) {
        if (-not (Test-Path $ApiTarget)) {
            New-Item -ItemType Directory -Force -Path $ApiTarget | Out-Null
        }
        Copy-Item -Path $apiFile -Destination (Join-Path $ApiTarget $apiName) -Force
    }
    Write-Host "  [API]     $apiName" -ForegroundColor Cyan
    $apiCopied++
}

# Prometheus exporters live in monitoring\ and are launched from D:, so mirror the
# whole monitoring\*.py set there. The *.yml configs go to config\ further below;
# these are the processes prometheus.yml scrapes on 9192/9193.
$MonitoringPySource = Join-Path (Split-Path $SourceDir -Parent) "monitoring"
$MonitoringTarget = Join-Path $BaseDir "monitoring"
$monitoringCopied = 0
Write-Host "`nMONITORING EXPORTER SYNC -> $MonitoringTarget" -ForegroundColor Yellow
if (Test-Path $MonitoringPySource) {
    $monitoringPyFiles = @(Get-ChildItem -Path (Join-Path $MonitoringPySource "*.py") -File -ErrorAction SilentlyContinue)
    if ($monitoringPyFiles.Count -eq 0) {
        Write-Host "  [ABSENT]  no *.py under $MonitoringPySource" -ForegroundColor DarkYellow
    }
    foreach ($pyFile in $monitoringPyFiles) {
        if (-not $DryRun) {
            if (-not (Test-Path $MonitoringTarget)) {
                New-Item -ItemType Directory -Force -Path $MonitoringTarget | Out-Null
            }
            Copy-Item -Path $pyFile.FullName -Destination (Join-Path $MonitoringTarget $pyFile.Name) -Force
        }
        Write-Host "  [MONITOR] $($pyFile.Name)" -ForegroundColor Cyan
        $monitoringCopied++
    }
} else {
    Write-Host "  [ABSENT]  $MonitoringPySource" -ForegroundColor DarkYellow
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

# Checks the process environment AND the .env files hybrid_env.py reads, because
# reporting only the former was a false negative: credentials in
# D:\MusicDatasets\.env resolve fine for the daemons while being absent from the
# shell, so this said MISSING for variables that were actually available.
$repoRoot = Split-Path $SourceDir -Parent
$envFileCandidates = @(
    (Join-Path $BaseDir ".env"),
    (Join-Path $BaseDir ".env.local"),
    (Join-Path $TargetDir ".env"),
    (Join-Path $repoRoot ".env"),
    (Join-Path $repoRoot ".env.local")
) | Where-Object { $_ -and (Test-Path $_) }

foreach ($varName in @("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")) {
    $value = [Environment]::GetEnvironmentVariable($varName)

    if ($value) {
        Write-Host "  [OK]      $varName is set (environment)" -ForegroundColor Green
        continue
    }

    $foundIn = $null
    foreach ($envFile in $envFileCandidates) {
        if (Select-String -Path $envFile -Pattern "^\s*(?:export\s+)?$varName\s*=\s*\S" -Quiet) {
            $foundIn = $envFile
            break
        }
    }

    if ($foundIn) {
        Write-Host "  [OK]      $varName resolves from $foundIn" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $varName - not in environment or any .env" -ForegroundColor Red
        $envOk = $false
    }
}

# Python is checked via the resolver, not Get-Command: PATH usually resolves to
# the WindowsApps App Execution Alias stub, which is not an interpreter.
. "$SourceDir\resolve_python.ps1"
$resolvedPython = Get-HybridPython -Quiet

if ($resolvedPython) {
    Write-Host "  [OK]      python $((& $resolvedPython --version 2>&1) -replace 'Python\s*','') at $resolvedPython" -ForegroundColor Green

    # scipy and prometheus_client are load-bearing, not optional: the QC
    # analyzer needs scipy for BS.1770 K-weighting and polyphase true-peak
    # detection, and silently degrades to unweighted loudness and sample peak
    # without it - which the upload gate would then act on.
    foreach ($pkg in @("supabase", "pydub", "psutil", "watchdog", "numpy",
                       "scipy", "prometheus_client")) {
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
