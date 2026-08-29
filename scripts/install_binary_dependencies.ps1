<#
.SYNOPSIS
    Hybrid 1.0 - Automated Toolchain & Binary Installer
.DESCRIPTION
    Downloads, extracts, and configures NSSM, Prometheus, Alertmanager and
    optionally Grafana into the D:\MusicDatasets toolchain directory.

    NSSM goes to D:\MusicDatasets\monitoring\nssm rather than System32: dropping
    binaries into a system directory is hard to reverse and needs no elevation
    when it lives beside the rest of the toolchain. The directory is appended to
    the Machine PATH, and to the current session's PATH so scripts run later in
    this same shell can find it without a restart.
.PARAMETER IncludeGrafana
    Also download Grafana (large, ~100 MB) and unpack it under monitoring\grafana_bin.
.PARAMETER SkipPathUpdate
    Do not modify the Machine PATH (session PATH is still updated).
#>

param(
    [string]$BaseDir = "D:\MusicDatasets",
    [switch]$IncludeGrafana = $false,
    [switch]$SkipPathUpdate = $false
)

$ErrorActionPreference = "Stop"

$PROMETHEUS_VERSION   = "2.52.0"
$ALERTMANAGER_VERSION = "0.27.0"
$NSSM_VERSION         = "2.24"
$GRAFANA_VERSION      = "11.1.0"

$MonitoringDir = Join-Path $BaseDir "monitoring"
$NssmDir       = Join-Path $MonitoringDir "nssm"
$TempDir       = Join-Path $env:TEMP "hybrid_toolchain_dl"

$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)
$IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

@(
    $MonitoringDir,
    (Join-Path $MonitoringDir "prometheus"),
    (Join-Path $MonitoringDir "alertmanager"),
    $NssmDir,
    $TempDir
) | ForEach-Object {
    if (!(Test-Path $_)) { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - AUTOMATED BINARY ACQUISITION & INSTALLER" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Toolchain root : $MonitoringDir"
Write-Host "Elevated       : $IsAdmin"
Write-Host "================================================================" -ForegroundColor Cyan

function Get-Archive {
    param([string]$Url, [string]$OutFile, [string]$Label)

    Write-Host "  Downloading $Label..." -ForegroundColor Gray
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # ProgressPreference=SilentlyContinue makes Invoke-WebRequest dramatically
    # faster on large files by skipping per-chunk progress rendering.
    $prev = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    } finally {
        $ProgressPreference = $prev
    }

    $sw.Stop()
    $sizeMb = [math]::Round((Get-Item $OutFile).Length / 1MB, 1)
    Write-Host "  Retrieved $sizeMb MB in $([math]::Round($sw.Elapsed.TotalSeconds,1))s" -ForegroundColor Gray
}

$installed = @()
$skipped = @()

# -------------------------------------------------------------------------
# 1. NSSM
# -------------------------------------------------------------------------
$NssmExeTarget = Join-Path $NssmDir "nssm.exe"

if (Test-Path $NssmExeTarget) {
    Write-Host "`n[1/4] NSSM already present at $NssmExeTarget" -ForegroundColor Gray
    $skipped += "nssm"
} elseif (Get-Command nssm -ErrorAction SilentlyContinue) {
    Write-Host "`n[1/4] NSSM already resolvable in PATH." -ForegroundColor Gray
    $skipped += "nssm"
} else {
    Write-Host "`n[1/4] Installing NSSM $NSSM_VERSION..." -ForegroundColor Yellow
    $nssmZip = Join-Path $TempDir "nssm.zip"
    Get-Archive -Url "https://nssm.cc/release/nssm-$NSSM_VERSION.zip" -OutFile $nssmZip -Label "NSSM"

    $nssmExtract = Join-Path $TempDir "nssm_extracted"
    Expand-Archive -Path $nssmZip -DestinationPath $nssmExtract -Force

    $archFolder = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
    $nssmSrc = Join-Path $nssmExtract "nssm-$NSSM_VERSION\$archFolder\nssm.exe"

    if (-not (Test-Path $nssmSrc)) {
        # Fall back to a recursive search in case the archive layout changed
        $found = Get-ChildItem -Path $nssmExtract -Filter "nssm.exe" -Recurse |
            Where-Object { $_.DirectoryName -like "*$archFolder*" } |
            Select-Object -First 1
        if (-not $found) { throw "nssm.exe not found in the downloaded archive." }
        $nssmSrc = $found.FullName
    }

    Copy-Item -Path $nssmSrc -Destination $NssmExeTarget -Force
    Write-Host "  -> [INSTALLED] $NssmExeTarget" -ForegroundColor Green
    $installed += "nssm"
}

# Make nssm resolvable now, and persistently
if (Test-Path $NssmExeTarget) {
    if ($env:PATH -notlike "*$NssmDir*") {
        $env:PATH = "$env:PATH;$NssmDir"
        Write-Host "  -> Added to session PATH." -ForegroundColor Gray
    }

    if (-not $SkipPathUpdate) {
        if ($IsAdmin) {
            $machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
            if ($machinePath -notlike "*$NssmDir*") {
                [Environment]::SetEnvironmentVariable("PATH", "$machinePath;$NssmDir", "Machine")
                Write-Host "  -> Appended to Machine PATH (new shells will resolve nssm)." -ForegroundColor Gray
            }
        } else {
            Write-Host "  -> [WARN] Not elevated; Machine PATH unchanged. nssm resolves only in this session." -ForegroundColor Yellow
            Write-Host "     Re-run elevated, or add $NssmDir to PATH manually." -ForegroundColor Yellow
        }
    }
}

# -------------------------------------------------------------------------
# 2. PROMETHEUS
# -------------------------------------------------------------------------
$PromTarget = Join-Path $MonitoringDir "prometheus\prometheus.exe"

if (Test-Path $PromTarget) {
    Write-Host "`n[2/4] Prometheus already present." -ForegroundColor Gray
    $skipped += "prometheus"
} else {
    Write-Host "`n[2/4] Installing Prometheus $PROMETHEUS_VERSION..." -ForegroundColor Yellow
    $promZip = Join-Path $TempDir "prometheus.zip"
    Get-Archive -Url "https://github.com/prometheus/prometheus/releases/download/v$PROMETHEUS_VERSION/prometheus-$PROMETHEUS_VERSION.windows-amd64.zip" `
                -OutFile $promZip -Label "Prometheus"

    $promExtract = Join-Path $TempDir "prom_extracted"
    Expand-Archive -Path $promZip -DestinationPath $promExtract -Force

    $promRoot = Get-ChildItem -Path $promExtract -Directory | Select-Object -First 1
    Copy-Item -Path (Join-Path $promRoot.FullName "*") -Destination (Join-Path $MonitoringDir "prometheus") -Recurse -Force

    if (Test-Path $PromTarget) {
        Write-Host "  -> [INSTALLED] $PromTarget" -ForegroundColor Green
        $installed += "prometheus"
    } else {
        Write-Host "  -> [ERROR] prometheus.exe not found after extraction." -ForegroundColor Red
    }
}

# -------------------------------------------------------------------------
# 3. ALERTMANAGER
# -------------------------------------------------------------------------
$AmTarget = Join-Path $MonitoringDir "alertmanager\alertmanager.exe"

if (Test-Path $AmTarget) {
    Write-Host "`n[3/4] Alertmanager already present." -ForegroundColor Gray
    $skipped += "alertmanager"
} else {
    Write-Host "`n[3/4] Installing Alertmanager $ALERTMANAGER_VERSION..." -ForegroundColor Yellow
    $amZip = Join-Path $TempDir "alertmanager.zip"
    Get-Archive -Url "https://github.com/prometheus/alertmanager/releases/download/v$ALERTMANAGER_VERSION/alertmanager-$ALERTMANAGER_VERSION.windows-amd64.zip" `
                -OutFile $amZip -Label "Alertmanager"

    $amExtract = Join-Path $TempDir "am_extracted"
    Expand-Archive -Path $amZip -DestinationPath $amExtract -Force

    $amRoot = Get-ChildItem -Path $amExtract -Directory | Select-Object -First 1
    Copy-Item -Path (Join-Path $amRoot.FullName "*") -Destination (Join-Path $MonitoringDir "alertmanager") -Recurse -Force

    if (Test-Path $AmTarget) {
        Write-Host "  -> [INSTALLED] $AmTarget" -ForegroundColor Green
        $installed += "alertmanager"
    } else {
        Write-Host "  -> [ERROR] alertmanager.exe not found after extraction." -ForegroundColor Red
    }
}

# -------------------------------------------------------------------------
# 4. GRAFANA (optional)
# -------------------------------------------------------------------------
$GrafanaDir = Join-Path $MonitoringDir "grafana_bin"

if (-not $IncludeGrafana) {
    Write-Host "`n[4/4] Grafana skipped (pass -IncludeGrafana to install)." -ForegroundColor Gray
    $skipped += "grafana"
} elseif (Test-Path (Join-Path $GrafanaDir "bin\grafana-server.exe")) {
    Write-Host "`n[4/4] Grafana already present." -ForegroundColor Gray
    $skipped += "grafana"
} else {
    Write-Host "`n[4/4] Installing Grafana $GRAFANA_VERSION (large download)..." -ForegroundColor Yellow
    $gfZip = Join-Path $TempDir "grafana.zip"
    Get-Archive -Url "https://dl.grafana.com/oss/release/grafana-$GRAFANA_VERSION.windows-amd64.zip" `
                -OutFile $gfZip -Label "Grafana"

    $gfExtract = Join-Path $TempDir "gf_extracted"
    Expand-Archive -Path $gfZip -DestinationPath $gfExtract -Force

    $gfRoot = Get-ChildItem -Path $gfExtract -Directory | Select-Object -First 1
    if (!(Test-Path $GrafanaDir)) { New-Item -ItemType Directory -Force -Path $GrafanaDir | Out-Null }
    Copy-Item -Path (Join-Path $gfRoot.FullName "*") -Destination $GrafanaDir -Recurse -Force

    Write-Host "  -> [INSTALLED] $GrafanaDir" -ForegroundColor Green
    Write-Host "     Note: Grafana defaults to port 3000, which collides with 'next dev'." -ForegroundColor Yellow
    Write-Host "     Set http_port in conf\custom.ini if both need to run." -ForegroundColor Yellow
    $installed += "grafana"
}

# -------------------------------------------------------------------------
# CLEANUP & SUMMARY
# -------------------------------------------------------------------------
Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "TOOLCHAIN ACQUISITION COMPLETE" -ForegroundColor Green
Write-Host "  Installed : $(if ($installed.Count) { $installed -join ', ' } else { 'nothing new' })"
Write-Host "  Skipped   : $(if ($skipped.Count) { $skipped -join ', ' } else { 'none' })"
Write-Host "================================================================" -ForegroundColor Cyan

Write-Host "`nVerification:" -ForegroundColor Yellow
foreach ($check in @(
    @{ Label = "nssm";         Path = $NssmExeTarget },
    @{ Label = "prometheus";   Path = $PromTarget },
    @{ Label = "alertmanager"; Path = $AmTarget }
)) {
    $state = if (Test-Path $check.Path) { "[OK]     " } else { "[MISSING]" }
    Write-Host "  $state $($check.Label.PadRight(14)) $($check.Path)"
}

Write-Host "`nNext: register_all_services.ps1 (elevated) to install the daemons." -ForegroundColor Cyan
