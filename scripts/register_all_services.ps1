<#
.SYNOPSIS
    Registers all seven Hybrid 1.0 daemons as NSSM services in one pass.
.DESCRIPTION
    Replaces running nssm_daemon_setup.ps1, nssm_watchdog_setup.ps1,
    register_prometheus_exporter_service.ps1, register_monitoring_services.ps1
    and register_stagnation_healer_service.ps1 separately.

    Log filenames match the $LogMappings table in tail_logs.ps1, and TSDB paths
    match the scaffold created by deploy_to_workstation.ps1, so -Service <name>
    and the storage guard both resolve correctly.

    Prometheus and Alertmanager are omitted rather than half-registered when
    their binaries are absent.
.PARAMETER PrometheusBind
    Listen address for Prometheus. Loopback by default - it ships with no auth.
.PARAMETER AlertmanagerBind
    Listen address for Alertmanager. Its API can create silences, so loopback.
.PARAMETER EnablePrometheusLifecycle
    Enables /-/reload. Also exposes an unauthenticated /-/quit, so opt-in only.
#>

param(
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$PrometheusBind = "127.0.0.1:9090",
    [string]$AlertmanagerBind = "127.0.0.1:9093",
    [switch]$EnablePrometheusLifecycle = $false,
    [switch]$SkipStart = $false
)

$ErrorActionPreference = "Stop"

$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)

if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[ERROR] Administrator privileges required to register Windows services." -ForegroundColor Red
    exit 1
}

if (!(Get-Command nssm -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] NSSM not found in PATH. Install it first: choco install nssm" -ForegroundColor Red
    exit 1
}

# Resolve a real interpreter. (Get-Command python).Source returns the
# WindowsApps App Execution Alias stub on this machine, which is not an
# interpreter - services registered against it install fine then die on start.
. "$PSScriptRoot\resolve_python.ps1"
$PythonPath = Assert-HybridPython

$LogDir     = Join-Path $BaseDir "logs"
$ScriptsDir = Join-Path $BaseDir "scripts"
$ConfigDir  = Join-Path $BaseDir "config"

$PrometheusExe   = Join-Path $BaseDir "monitoring\prometheus\prometheus.exe"
$AlertmanagerExe = Join-Path $BaseDir "monitoring\alertmanager\alertmanager.exe"
$PromDataDir     = Join-Path $BaseDir "monitoring\data\prometheus"
$AlertDataDir    = Join-Path $BaseDir "monitoring\data\alertmanager"

foreach ($dir in @($LogDir, $PromDataDir, $AlertDataDir)) {
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - NSSM SERVICE REGISTRATION SUITE" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Interpreter : $PythonPath"
Write-Host "Scripts     : $ScriptsDir"
Write-Host "================================================================" -ForegroundColor Cyan

# Python daemons. Stdout/stderr names must match tail_logs.ps1.
$ServiceDefinitions = @(
    @{
        Name   = "HybridPrometheusExporterDaemon"
        Exe    = $PythonPath
        Args   = "`"$ScriptsDir\prometheus_exporter.py`""
        Desc   = "Hybrid 1.0 Prometheus Metrics Exporter (127.0.0.1:9191)"
        Stdout = "$LogDir\prometheus_exporter_stdout.log"
        Stderr = "$LogDir\prometheus_exporter_stderr.log"
    },
    @{
        Name   = "HybridAlertBridgeDaemon"
        Exe    = $PythonPath
        Args   = "`"$ScriptsDir\alertmanager_bridge.py`""
        Desc   = "Hybrid 1.0 Alertmanager Notification Bridge (127.0.0.1:5001)"
        Stdout = "$LogDir\alert_bridge_stdout.log"
        Stderr = "$LogDir\alert_bridge_stderr.log"
    },
    @{
        # Was present in manage_all_services and the health check but missing
        # here, so it appeared in every status report as "not installed".
        Name   = "HybridHardwareMacroDaemon"
        Exe    = $PythonPath
        Args   = "`"$ScriptsDir\hardware_macro_server.py`""
        Desc   = "Hybrid 1.0 Hardware Macro & Stream Deck API (127.0.0.1:8765)"
        Stdout = "$LogDir\macro_server_stdout.log"
        Stderr = "$LogDir\macro_server_stderr.log"
    },
    @{
        Name   = "HybridStorageGuardDaemon"
        Exe    = $PythonPath
        Args   = "`"$ScriptsDir\storage_guard_daemon.py`""
        Desc   = "Hybrid 1.0 Drive D Storage Guard Daemon"
        Stdout = "$LogDir\storage_guard_stdout.log"
        Stderr = "$LogDir\storage_guard_stderr.log"
    },
    @{
        Name   = "HybridStagnationHealerDaemon"
        Exe    = $PythonPath
        Args   = "`"$ScriptsDir\pipeline_stagnation_healer.py`""
        Desc   = "Hybrid 1.0 Pipeline Stagnation and Dead-Letter Healer"
        Stdout = "$LogDir\stagnation_healer_stdout.log"
        Stderr = "$LogDir\stagnation_healer_stderr.log"
    },
    @{
        Name   = "HybridWatchdogDaemon"
        Exe    = $PythonPath
        Args   = "`"$ScriptsDir\watchdog_slicing_daemon.py`""
        Desc   = "Hybrid 1.0 Audio Ingest and 1000ms Slicing Watchdog"
        Stdout = "$LogDir\watchdog_stdout.log"
        Stderr = "$LogDir\watchdog_stderr.log"
    },
    @{
        Name   = "HybridAudioDaemon"
        Exe    = $PythonPath
        Args   = "`"$ScriptsDir\daemon_poller.py`""
        Desc   = "Hybrid 1.0 Supabase Queue Poller and Render Dispatcher"
        Stdout = "$LogDir\audio_daemon_stdout.log"
        Stderr = "$LogDir\audio_daemon_stderr.log"
    }
)

# Monitoring binaries, only if actually present
if (Test-Path $PrometheusExe) {
    $promArgs = "--config.file=`"$ConfigDir\prometheus.yml`" --storage.tsdb.path=`"$PromDataDir`" --web.listen-address=`"$PrometheusBind`""
    if ($EnablePrometheusLifecycle) { $promArgs += " --web.enable-lifecycle" }

    $ServiceDefinitions += @{
        Name   = "HybridPrometheusDaemon"
        Exe    = $PrometheusExe
        Args   = $promArgs
        Desc   = "Hybrid 1.0 Prometheus TSDB Engine ($PrometheusBind)"
        Stdout = "$LogDir\prometheus_stdout.log"
        Stderr = "$LogDir\prometheus_stderr.log"
    }
} else {
    Write-Host "[SKIP] prometheus.exe not found at $PrometheusExe" -ForegroundColor Yellow
}

if (Test-Path $AlertmanagerExe) {
    $ServiceDefinitions += @{
        Name   = "HybridAlertmanagerDaemon"
        Exe    = $AlertmanagerExe
        Args   = "--config.file=`"$ConfigDir\alertmanager.yml`" --storage.path=`"$AlertDataDir`" --web.listen-address=`"$AlertmanagerBind`""
        Desc   = "Hybrid 1.0 Alertmanager Webhook Router ($AlertmanagerBind)"
        Stdout = "$LogDir\alertmanager_stdout.log"
        Stderr = "$LogDir\alertmanager_stderr.log"
    }
} else {
    Write-Host "[SKIP] alertmanager.exe not found at $AlertmanagerExe" -ForegroundColor Yellow
}

# Credentials. NSSM services run as LOCAL SYSTEM and inherit only
# Machine-scoped variables; every Python daemon exits immediately without them.
$machineUrl = [Environment]::GetEnvironmentVariable("SUPABASE_URL", "Machine")
$machineKey = [Environment]::GetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY", "Machine")
$injectEnv = $false

if (-not $machineUrl -or -not $machineKey) {
    if ($env:SUPABASE_URL -and $env:SUPABASE_SERVICE_ROLE_KEY) {
        $injectEnv = $true
        Write-Host "[INFO] Machine-scope credentials absent; injecting from this shell." -ForegroundColor Gray
    } else {
        Write-Host "[WARN] Supabase credentials not available at Machine scope or in this shell." -ForegroundColor Yellow
        Write-Host "       Python daemons will exit on start until they are set:" -ForegroundColor Yellow
        Write-Host '       [Environment]::SetEnvironmentVariable("SUPABASE_URL","<url>","Machine")' -ForegroundColor Gray
        Write-Host '       [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY","<key>","Machine")' -ForegroundColor Gray
    }
}

$registered = 0
$failed = @()

foreach ($svc in $ServiceDefinitions) {
    $sname = $svc.Name
    Write-Host "`n[CONFIGURING] $sname..." -ForegroundColor Yellow

    try {
        if (Get-Service -Name $sname -ErrorAction SilentlyContinue) {
            nssm stop $sname | Out-Null
            nssm remove $sname confirm | Out-Null
        }

        nssm install $sname $svc.Exe $svc.Args
        nssm set $sname AppDirectory $ScriptsDir
        nssm set $sname Description $svc.Desc
        nssm set $sname Start SERVICE_AUTO_START

        nssm set $sname AppStdout $svc.Stdout
        nssm set $sname AppStderr $svc.Stderr
        nssm set $sname AppRotateFiles 1
        nssm set $sname AppRotateBytes 10485760

        # Rotate while the service holds the handle. Without this a long-running
        # daemon keeps writing to the same file regardless of size, because NSSM
        # only rotates at startup.
        nssm set $sname AppRotateOnline 1
        nssm set $sname AppRotateSeconds 86400

        # Crash backoff. AppThrottle is the window in which a fast exit counts as
        # a failed start; without it a daemon that dies immediately - missing
        # credentials, for instance - respawns in a tight loop and floods the log
        # with the same traceback. AppRestartDelay spaces the retries.
        nssm set $sname AppThrottle 1500
        nssm set $sname AppRestartDelay 5000

        # Give the process a chance to exit cleanly before NSSM escalates to
        # terminate, so a daemon mid-write is not killed with a partial file.
        nssm set $sname AppStopMethodConsole 3000
        nssm set $sname AppStopMethodWindow 3000
        nssm set $sname AppStopMethodThreads 3000

        if ($injectEnv) {
            # Fallback only. AppEnvironmentExtra writes the value into this
            # service's registry key, where `nssm dump <service>` and any admin
            # process can read it back in clear text. Machine-scope variables are
            # preferred above because the key is then stored once rather than
            # duplicated into every service definition, and it never appears in a
            # script or a service dump. Never hardcode the key into a committed
            # installer file.
            nssm set $sname AppEnvironmentExtra `
                "SUPABASE_URL=$($env:SUPABASE_URL)" `
                "SUPABASE_SERVICE_ROLE_KEY=$($env:SUPABASE_SERVICE_ROLE_KEY)"
        }

        if (-not $SkipStart) {
            nssm start $sname
        }

        Write-Host "  -> [INSTALLED$(if (-not $SkipStart) { ' & STARTED' })] $sname" -ForegroundColor Green
        $registered++
    } catch {
        Write-Host "  -> [FAILED] $sname : $($_.Exception.Message)" -ForegroundColor Red
        $failed += $sname
    }
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "REGISTRATION SUMMARY: $registered of $($ServiceDefinitions.Count) service(s) configured" -ForegroundColor $(if ($failed.Count -eq 0) { "Green" } else { "Yellow" })

if ($failed.Count -gt 0) {
    Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
}

Start-Sleep -Seconds 2
Get-Service -Name "Hybrid*" -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType -AutoSize
Write-Host "================================================================" -ForegroundColor Cyan
