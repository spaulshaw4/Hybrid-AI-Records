<#
.SYNOPSIS
    Hybrid 1.0 - One-Click Master Bootstrap & Deployment Orchestrator
.DESCRIPTION
    End-to-end initialization: installs Python dependencies, syncs all scripts and
    configs from the repo to D:, provisions Grafana, registers the seven Windows
    daemons via NSSM, creates desktop shortcuts, starts the tray monitor, and runs
    full health verification.

    Missing prerequisites downgrade individual steps to a skip rather than aborting
    the run, so this is usable before nssm or the monitoring binaries are installed.
.PARAMETER RepoDir
    Repo scripts directory, used as the sync source. deploy_to_workstation.ps1
    refuses to run when source and target are the same folder, so this must point
    at the git checkout rather than D:\MusicDatasets\scripts.
.PARAMETER SkipDeploy
    Skip the repo-to-D: sync (use when already deployed).
#>

param(
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$RepoDir = "C:\Users\spaul\Downloads\Hybrid AI Forge (10)\scripts",
    [switch]$SkipDeploy = $false
)

$ErrorActionPreference = "Stop"

# -------------------------------------------------------------------------
# 0. ELEVATION CHECK
# -------------------------------------------------------------------------
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)
$IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $IsAdmin) {
    Write-Host "[ELEVATING] Administrator privileges required. Relaunching in elevated terminal..." -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$ScriptsDir = Join-Path $BaseDir "scripts"
$skipped = @()

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "       HYBRID 1.0 - MASTER BOOTSTRAP & PROVISIONING SUITE       " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Target Directory : $BaseDir"
Write-Host "Repo Source      : $RepoDir"
Write-Host "Execution Time   : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n"

# -------------------------------------------------------------------------
# 1. PREREQUISITE & ENVIRONMENT VALIDATION
# -------------------------------------------------------------------------
Write-Host "[STEP 1/8] Validating runtime binaries and environment variables..." -ForegroundColor Yellow

# Resolve a real interpreter. Get-Command python.exe returns the WindowsApps
# App Execution Alias stub on this machine, which is not an interpreter.
$resolverPath = Join-Path $RepoDir "resolve_python.ps1"
if (-not (Test-Path $resolverPath)) { $resolverPath = Join-Path $ScriptsDir "resolve_python.ps1" }

if (-not (Test-Path $resolverPath)) {
    throw "resolve_python.ps1 not found in $RepoDir or $ScriptsDir."
}

. $resolverPath
$Python = Assert-HybridPython
Write-Host "  -> Python: $((& $Python --version 2>&1)) at $Python" -ForegroundColor Green

$pathStub = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($pathStub -like "*\WindowsApps\*") {
    Write-Host "  -> [WARN] PATH 'python' resolves to the Store stub. Scripts calling bare 'python' will fail." -ForegroundColor DarkYellow
}

if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Host "  -> ffmpeg found." -ForegroundColor Green
} else {
    Write-Host "  -> [WARN] ffmpeg not in PATH. pydub cannot decode mp3/flac without it." -ForegroundColor DarkYellow
}

$NSSM = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $NSSM) {
    Write-Host "  -> [WARN] nssm not in PATH. Service registration will be skipped." -ForegroundColor DarkYellow
}

if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_ROLE_KEY) {
    Write-Host "  -> [WARN] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. Daemons will exit on start." -ForegroundColor DarkYellow
} else {
    Write-Host "  -> Supabase credentials detected." -ForegroundColor Green
}

# -------------------------------------------------------------------------
# 2. PYTHON PACKAGE INSTALLATION
# -------------------------------------------------------------------------
Write-Host "`n[STEP 2/8] Installing required Python libraries..." -ForegroundColor Yellow

# pydub, psutil and watchdog are not optional: the slicers, telemetry emitter,
# exporter, storage guard and ingest watchdog all import them at module scope.
# scipy is required, not optional: audio_qc_analyzer uses it for the BS.1770
# K-weighting biquads and polyphase true-peak oversampling. Without it the
# analyzer falls back to unweighted loudness and sample peak, and since the QC
# gate now blocks uploads, that would mean gating on the wrong numbers.
$PipPackages = @("supabase", "pydub", "psutil", "watchdog", "prometheus_client", "numpy", "scipy", "pystray", "pillow")

& $Python -m pip install --quiet --upgrade @PipPackages

$missing = @()
foreach ($pkg in @("supabase", "pydub", "psutil", "watchdog", "prometheus_client", "numpy", "scipy")) {
    & $Python -c "import $pkg" 2>$null
    if ($LASTEXITCODE -ne 0) { $missing += $pkg }
}

if ($missing.Count -eq 0) {
    Write-Host "  -> All required packages import cleanly." -ForegroundColor Green
} else {
    Write-Host "  -> [WARN] Still not importable: $($missing -join ', ')" -ForegroundColor DarkYellow
}

# -------------------------------------------------------------------------
# 3. SYNC SCRIPTS, CONFIGS AND GRAFANA ASSETS FROM THE REPO
# -------------------------------------------------------------------------
Write-Host "`n[STEP 3/8] Syncing scripts, configs and dashboards from the repo..." -ForegroundColor Yellow

if ($SkipDeploy) {
    Write-Host "  -> [SKIP] -SkipDeploy specified." -ForegroundColor DarkGray
    $skipped += "deploy"
} else {
    $deployScript = Join-Path $RepoDir "deploy_to_workstation.ps1"

    if (Test-Path $deployScript) {
        & $deployScript -BaseDir $BaseDir
    } else {
        Write-Host "  -> [SKIP] deploy_to_workstation.ps1 not found in $RepoDir." -ForegroundColor DarkGray
        Write-Host "     Pass -RepoDir pointing at the git checkout's scripts folder." -ForegroundColor DarkGray
        $skipped += "deploy"
    }
}

# -------------------------------------------------------------------------
# 4. GRAFANA PROVISIONING
# -------------------------------------------------------------------------
Write-Host "`n[STEP 4/8] Provisioning Grafana datasource and dashboards..." -ForegroundColor Yellow

$grafanaScript = Join-Path $ScriptsDir "setup_grafana_provisioning.ps1"
if (Test-Path $grafanaScript) {
    & $grafanaScript -BaseDir $BaseDir
} else {
    Write-Host "  -> [SKIP] setup_grafana_provisioning.ps1 not found." -ForegroundColor DarkGray
    $skipped += "grafana"
}

# -------------------------------------------------------------------------
# 5. REGISTER & LAUNCH THE WINDOWS DAEMONS
# -------------------------------------------------------------------------
Write-Host "`n[STEP 5/8] Registering persistent daemon services via NSSM..." -ForegroundColor Yellow

$RegisterServicesScript = Join-Path $ScriptsDir "register_all_services.ps1"

if (-not $NSSM) {
    Write-Host "  -> [SKIP] nssm unavailable. Install it, then run register_all_services.ps1." -ForegroundColor DarkGray
    $skipped += "services"
} elseif (Test-Path $RegisterServicesScript) {
    & $RegisterServicesScript -BaseDir $BaseDir
} else {
    Write-Host "  -> [SKIP] register_all_services.ps1 not found at $RegisterServicesScript." -ForegroundColor DarkGray
    $skipped += "services"
}

# -------------------------------------------------------------------------
# 6. DESKTOP LAUNCHERS
# -------------------------------------------------------------------------
Write-Host "`n[STEP 6/8] Generating administrative desktop shortcuts..." -ForegroundColor Yellow

$ShortcutsScript = Join-Path $ScriptsDir "setup_desktop_shortcuts.ps1"
if (Test-Path $ShortcutsScript) {
    & $ShortcutsScript
} else {
    Write-Host "  -> [SKIP] setup_desktop_shortcuts.ps1 not found." -ForegroundColor DarkGray
    $skipped += "shortcuts"
}

# -------------------------------------------------------------------------
# 7. SYSTEM TRAY CONTROLLER
# -------------------------------------------------------------------------
Write-Host "`n[STEP 7/8] Initializing system tray monitoring controller..." -ForegroundColor Yellow

$RestartTrayScript = Join-Path $ScriptsDir "restart_tray_app.ps1"
if (Test-Path $RestartTrayScript) {
    & $RestartTrayScript
} else {
    Write-Host "  -> [SKIP] restart_tray_app.ps1 not found." -ForegroundColor DarkGray
    $skipped += "tray"
}

# -------------------------------------------------------------------------
# 8. HEALTH & READINESS VERIFICATION
# -------------------------------------------------------------------------
Write-Host "`n[STEP 8/8] Running comprehensive health and readiness diagnostics..." -ForegroundColor Yellow
Start-Sleep -Seconds 2

$VerifyScript = Join-Path $ScriptsDir "verify_pipeline_health.ps1"
if (Test-Path $VerifyScript) {
    & $VerifyScript -BaseDir $BaseDir
} else {
    Write-Host "  -> [WARN] Diagnostics script missing at $VerifyScript" -ForegroundColor Red
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "       HYBRID 1.0 BOOTSTRAP SUITE COMPLETED                     " -ForegroundColor Green

if ($skipped.Count -gt 0) {
    Write-Host "Skipped stages : $($skipped -join ', ')" -ForegroundColor Yellow
}

Write-Host "================================================================" -ForegroundColor Cyan
