# Safe workstation rollback. Default is dry-run.
# The original snippet killed every python/ffmpeg process, wiped scratch,
# and restarted healthy NSSM services. This script does none of that unless
# the operator opts in, and even then it only touches identified workers.
param(
    [string]$BaseDir = "D:\MusicDatasets",
    [int]$StaleMinutes = 45,
    [int]$ScratchAgeHours = 12,
    [switch]$DryRun,
    [switch]$WhatIf,
    [switch]$Execute,
    [switch]$Confirm,
    [switch]$PurgeScratch,
    [switch]$RestartDaemons
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $RepoRoot "scripts\resolve_python.ps1")

# Default is preview. Destructive work requires -Execute or -Confirm:$true.
# -DryRun / -WhatIf always win over -Execute.
$script:IsLive = $false
if ($Execute -or $Confirm) { $script:IsLive = $true }
if ($DryRun -or $WhatIf -or (-not $Execute -and -not $Confirm)) { $script:IsLive = $false }

$ModeLabel = if ($script:IsLive) { "[LIVE]" } else { "[DRY RUN - NO KILLS, NO DELETES]" }

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " HYBRID AI RECORDS - EMERGENCY ROLLBACK (SAFE)           " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Base       : $BaseDir"
Write-Host "Stale      : PROCESSING older than $StaleMinutes min -> FAILED"
Write-Host "Scratch    : session dirs older than $ScratchAgeHours h (opt-in -PurgeScratch)"
Write-Host "Mode       : $ModeLabel" -ForegroundColor $(if ($script:IsLive) { "Yellow" } else { "Green" })
Write-Host "Python     : Get-HybridPython (never D:\MusicDatasets\venv)"
Write-Host ""

function Write-Step {
    param([string]$Label, [string]$Detail, [string]$Color = "Gray")
    Write-Host "  [$Label] $Detail" -ForegroundColor $Color
}

# Same 8-daemon matrix as verify_system_readiness.ps1
$Services = @(
    "HybridAlertBridgeDaemon",
    "HybridAlertmanagerDaemon",
    "HybridAudioDaemon",
    "HybridPrometheusDaemon",
    "HybridPrometheusExporterDaemon",
    "HybridStagnationHealerDaemon",
    "HybridStorageGuardDaemon",
    "HybridWatchdogDaemon"
)

# Specific worker script names only. A bare "MusicDatasets" marker matched any
# python process whose command line mentioned the data root, which included live
# renders (generate_track_headless / blueprint_track_assembler) and ad-hoc
# indexing runs. Those are never rollback targets, so they are not listed here.
$WorkerMarkers = @(
    "master_queue_worker",
    "run_master_pipeline",
    "daemon_poller",
    "watchdog_slicing_daemon",
    "corpus_sync_daemon",
    "storage_guard_daemon",
    "pipeline_stagnation_healer",
    "db_sentinel",
    "log_rotation_guard",
    "hardware_thermal_guard",
    "batch_slicer_upload",
    "generic_slice_stager",
    "resilient_corpus_slicer",
    "batch_reslice_corpus"
)

function Test-WorkerCommandLine {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    foreach ($marker in $WorkerMarkers) {
        if ($CommandLine -like "*$marker*") { return $true }
    }
    return $false
}

# -------------------------------------------------------------------------
# 1. Identify worker processes. Never Stop-Process -Name python|ffmpeg.
# -------------------------------------------------------------------------
Write-Host "[1] Worker process inventory" -ForegroundColor Cyan
$identified = @()
$unidentified = @()
try {
    $candidates = Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -match '^(python|pythonw|ffmpeg)\.exe$' }
    foreach ($proc in $candidates) {
        $cmd = $proc.CommandLine
        if (-not $cmd) {
            $unidentified += $proc
            Write-Step "SKIP" "PID $($proc.ProcessId) $($proc.Name) - CommandLine unavailable; not killed" "Yellow"
            continue
        }
        if (Test-WorkerCommandLine -CommandLine $cmd) {
            $identified += $proc
            Write-Step "MATCH" "PID $($proc.ProcessId) $($proc.Name) $cmd" "Yellow"
        }
        else {
            Write-Step "KEEP" "PID $($proc.ProcessId) $($proc.Name) (not a named worker script)" "Gray"
        }
    }
}
catch {
    Write-Step "WARN" "Could not enumerate Win32_Process. No processes will be stopped. $($_.Exception.Message)" "Yellow"
}

if ($identified.Count -eq 0) {
    Write-Step "OK" "No identified workstation workers to stop." "Green"
}
elseif (-not $script:IsLive) {
    Write-Step "DRY" "Would stop $($identified.Count) identified worker(s). Pass -Execute to apply." "Green"
}
else {
    foreach ($proc in $identified) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Step "STOP" "PID $($proc.ProcessId) $($proc.Name)" "Yellow"
        }
        catch {
            Write-Step "FAIL" "PID $($proc.ProcessId): $($_.Exception.Message)" "Red"
        }
    }
}

# -------------------------------------------------------------------------
# 2. Ledger: stale PROCESSING only. Never delete the DB.
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "[2] Ledger stale PROCESSING -> FAILED" -ForegroundColor Cyan
$DbPath = Join-Path $BaseDir "database\master_catalog.db"
$PythonExe = Get-HybridPython -Quiet
if (-not $PythonExe) { $PythonExe = $env:HYBRID_PYTHON }

if (-not (Test-Path $DbPath)) {
    Write-Step "WARN" "Ledger missing at $DbPath" "Yellow"
}
elseif (-not $PythonExe) {
    Write-Step "FAIL" "No interpreter from Get-HybridPython. Ledger left untouched." "Red"
}
else {
    $ledgerScript = Join-Path $RepoRoot "scripts\ledger_schema.py"
    $ledgerArgs = @($ledgerScript, "--db", $DbPath, "--stale-minutes", "$StaleMinutes")
    if (-not $script:IsLive) { $ledgerArgs += "--dry-run" }
    $out = & $PythonExe @ledgerArgs 2>&1
    Write-Step $(if ($script:IsLive) { "LIVE" } else { "DRY" }) ("$out") "Green"
}

# -------------------------------------------------------------------------
# 3. Scratch: session_* dirs older than X hours. Never uploads. Opt-in.
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "[3] Scratch session purge" -ForegroundColor Cyan
$ScratchRoot = Join-Path $BaseDir "scratch"
$UploadsDir = Join-Path $ScratchRoot "uploads"
$Cutoff = (Get-Date).AddHours(-$ScratchAgeHours)

if (-not $PurgeScratch) {
    Write-Step "SKIP" "Pass -PurgeScratch to consider old session_* directories." "Gray"
}
elseif (-not (Test-Path $ScratchRoot)) {
    Write-Step "OK" "No scratch root at $ScratchRoot" "Green"
}
else {
    $targets = @(
        Get-ChildItem -Path $ScratchRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -ne "uploads" -and
                $_.FullName -ne $UploadsDir -and
                $_.Name -match '^(session_|import_)' -and
                $_.LastWriteTime -lt $Cutoff
            }
    )
    Write-Step "INFO" "uploads/ is never deleted. Matching $($targets.Count) aged session dir(s)." "Gray"
    foreach ($dir in $targets) {
        if (-not $script:IsLive) {
            Write-Step "DRY" "Would remove $($dir.FullName)" "Green"
            continue
        }
        try {
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction Stop
            Write-Step "PURGE" $dir.FullName "Yellow"
        }
        catch {
            Write-Step "FAIL" "$($dir.FullName): $($_.Exception.Message)" "Red"
        }
    }
}

# -------------------------------------------------------------------------
# 4. NSSM: restart only Stopped/Paused unless -RestartDaemons.
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "[4] NSSM daemon matrix" -ForegroundColor Cyan
foreach ($svc in $Services) {
    $serviceObj = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if (-not $serviceObj) {
        Write-Step "MISS" "$svc not registered" "Yellow"
        continue
    }
    $status = [string]$serviceObj.Status
    if ($status -eq "Running") {
        if ($RestartDaemons -and $script:IsLive) {
            try {
                Restart-Service -Name $svc -Force -ErrorAction Stop
                Write-Step "RESTART" "$svc was Running (-RestartDaemons)" "Yellow"
            }
            catch {
                Write-Step "FAIL" "$svc restart: $($_.Exception.Message)" "Red"
            }
        }
        else {
            Write-Step "KEEP" "$svc Running (healthy; pass -RestartDaemons to bounce)" "Green"
        }
        continue
    }
    if ($status -in @("Stopped", "Paused")) {
        if (-not $script:IsLive) {
            Write-Step "DRY" "Would resume $svc ($status)" "Green"
            continue
        }
        try {
            if ($status -eq "Paused") {
                Resume-Service -Name $svc -ErrorAction Stop
            }
            else {
                Start-Service -Name $svc -ErrorAction Stop
            }
            Write-Step "START" "$svc was $status" "Yellow"
        }
        catch {
            Write-Step "FAIL" "${svc}: $($_.Exception.Message)" "Red"
        }
        continue
    }
    Write-Step "WARN" "$svc status $status - left alone" "Yellow"
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
if ($script:IsLive) {
    Write-Host " LIVE rollback steps finished. Review ledger and daemons." -ForegroundColor Yellow
}
else {
    Write-Host " DRY RUN complete. Nothing was killed or deleted." -ForegroundColor Green
    Write-Host " Re-run with -Execute (or -Confirm:`$true) to apply." -ForegroundColor Green
}
Write-Host "==========================================================" -ForegroundColor Cyan
exit 0
