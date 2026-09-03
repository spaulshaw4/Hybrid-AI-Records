<#
.SYNOPSIS
    Preview or register HybridHeadlessJobDaemon via NSSM.
.DESCRIPTION
    Installs the headless job runner as HybridHeadlessJobDaemon.

    This is a new service name on purpose. The master-pipeline poller is
    HybridAudioDaemon; this script never stops, removes, or reconfigures that
    service, and it never writes audio_daemon_*.log.

    Default mode is preview (-DryRun / -WhatIf). Pass -Install to change the
    machine. The service is not started unless -Start is also passed.

    Python is resolved with Get-HybridPython from resolve_python.ps1. NSSM is
    located on PATH, C:\tools\nssm\nssm.exe, or Program Files. winget is used
    only when -InstallNssm is set.
.PARAMETER Install
    Apply NSSM install/set for HybridHeadlessJobDaemon. Required for any write.
.PARAMETER Start
    After a live install, start HybridHeadlessJobDaemon. Ignored in preview.
.PARAMETER DryRun
    Force preview even if -Install is also present.
.PARAMETER WhatIf
    Same as -DryRun (preview, no machine changes).
.PARAMETER InstallNssm
    If NSSM is missing, allow winget to install it. Still requires -Install.
.PARAMETER BaseDir
    Workstation root used for logs and the copied runner path.
.EXAMPLE
    .\install_headless_service.ps1
    .\install_headless_service.ps1 -Install
    .\install_headless_service.ps1 -Install -Start
#>

[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Start,
    [switch]$DryRun,
    [switch]$WhatIf,
    [switch]$InstallNssm,
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$BindHost = "127.0.0.1",
    [int]$BindPort = 8000
)

$ErrorActionPreference = "Stop"

$ServiceName = "HybridHeadlessJobDaemon"
$ProtectedService = "HybridAudioDaemon"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ResolvePython = Join-Path $PSScriptRoot "resolve_python.ps1"

if (-not (Test-Path $ResolvePython)) {
    Write-Host "[ERROR] resolve_python.ps1 not found at $ResolvePython" -ForegroundColor Red
    exit 1
}

. $ResolvePython

# Preview unless the operator opted in. -DryRun / -WhatIf always win.
$script:IsLive = [bool]$Install
if ($DryRun -or $WhatIf) { $script:IsLive = $false }

$LogDir = Join-Path $BaseDir "logs"
$StdoutLog = Join-Path $LogDir "headless_job_stdout.log"
$StderrLog = Join-Path $LogDir "headless_job_stderr.log"
$RepoRunner = Join-Path $RepoRoot "api\headless_job_runner.py"
$WorkstationRunner = Join-Path $BaseDir "api\headless_job_runner.py"
$BindNote = "${BindHost}:${BindPort}"

function Test-ProtectedServiceUntouched {
    if ($ServiceName -eq $ProtectedService) {
        throw "Refusing to operate on $ProtectedService."
    }
}

function Find-Nssm {
    $cmd = Get-Command nssm -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
        return $cmd.Source
    }

    $candidates = @(
        "C:\tools\nssm\nssm.exe",
        "C:\tools\nssm\win64\nssm.exe",
        (Join-Path $env:ProgramFiles "nssm\nssm.exe"),
        (Join-Path $env:ProgramFiles "nssm\win64\nssm.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nssm\nssm.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nssm\win64\nssm.exe")
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    return $null
}

function Resolve-HeadlessRunner {
    if (Test-Path -LiteralPath $RepoRunner) {
        return @{
            ScriptPath   = $RepoRunner
            AppDirectory = $RepoRoot
            Missing      = $false
            Source       = "repo"
        }
    }
    if (Test-Path -LiteralPath $WorkstationRunner) {
        return @{
            ScriptPath   = $WorkstationRunner
            AppDirectory = $BaseDir
            Missing      = $false
            Source       = "workstation"
        }
    }
    return @{
        ScriptPath   = $WorkstationRunner
        AppDirectory = $BaseDir
        Missing      = $true
        Source       = "intended"
    }
}

Test-ProtectedServiceUntouched

$Runner = Resolve-HeadlessRunner
$PythonPath = Get-HybridPython -Quiet
$NssmPath = Find-Nssm
$ModeLabel = if ($script:IsLive) { "[LIVE INSTALL]" } else { "[DRY RUN - NO MACHINE CHANGES]" }

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " HYBRID HEADLESS JOB DAEMON - NSSM INSTALLER" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Service     : $ServiceName"
Write-Host "Protected   : $ProtectedService will not be stopped, removed, or rewritten"
Write-Host "Bind        : $BindNote"
Write-Host "Mode        : $ModeLabel" -ForegroundColor $(if ($script:IsLive) { "Yellow" } else { "Green" })
Write-Host "Python      : Get-HybridPython (never (Get-Command python).Source)"
Write-Host "Logs        : $StdoutLog"
Write-Host "              $StderrLog"
Write-Host "================================================================" -ForegroundColor Cyan

if ($PythonPath) {
    Write-Host "  [OK]    Python : $PythonPath" -ForegroundColor Green
} else {
    Write-Host "  [WARN]  Python : not resolved. Set HYBRID_PYTHON or install CPython 3.x." -ForegroundColor Yellow
}

if ($NssmPath) {
    Write-Host "  [OK]    NSSM   : $NssmPath" -ForegroundColor Green
} else {
    Write-Host "  [WARN]  NSSM   : not on PATH, C:\tools\nssm, or Program Files." -ForegroundColor Yellow
    if ($InstallNssm) {
        Write-Host "          -InstallNssm is set; winget would run only under -Install." -ForegroundColor Gray
    } else {
        Write-Host "          Re-run with -Install -InstallNssm to winget-install NSSM, or place nssm.exe yourself." -ForegroundColor Gray
    }
}

if ($Runner.Missing) {
    Write-Host "  [WARN]  Runner : missing. Installer will still target:" -ForegroundColor Yellow
    Write-Host "          $($Runner.ScriptPath)" -ForegroundColor Yellow
    Write-Host "          Also accepted when present: $RepoRunner" -ForegroundColor Gray
} else {
    Write-Host "  [OK]    Runner : $($Runner.ScriptPath) ($($Runner.Source))" -ForegroundColor Green
}

Write-Host "  [OK]    AppDir : $($Runner.AppDirectory)" -ForegroundColor Green
Write-Host "  [INFO]  Start  : $(if ($Start -and $script:IsLive) { 'will start after install' } else { 'not started unless -Install -Start' })" -ForegroundColor Gray
Write-Host ""

if (-not $script:IsLive) {
    Write-Host "Preview plan (no nssm install/set/start/remove will run):" -ForegroundColor Cyan
    Write-Host "  nssm install $ServiceName <python> -u `"$($Runner.ScriptPath)`""
    Write-Host "  nssm set $ServiceName AppDirectory $($Runner.AppDirectory)"
    Write-Host "  nssm set $ServiceName Description `"Hybrid headless job runner ($BindNote)`""
    Write-Host "  nssm set $ServiceName AppStdout $StdoutLog"
    Write-Host "  nssm set $ServiceName AppStderr $StderrLog"
    Write-Host "  nssm set $ServiceName AppEnvironmentExtra PYTHONUNBUFFERED=1"
    Write-Host ""
    Write-Host "Re-run with -Install to register $ServiceName. Add -Start to start it." -ForegroundColor Yellow
    Write-Host "$ProtectedService is not in this plan and will not be touched." -ForegroundColor Green
    exit 0
}

$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[ERROR] Administrator privileges required for -Install." -ForegroundColor Red
    exit 1
}

if (-not $PythonPath) {
    Write-Host "[ERROR] No usable Python 3 interpreter from Get-HybridPython." -ForegroundColor Red
    exit 1
}

if (-not $NssmPath) {
    if ($InstallNssm) {
        Write-Host "[INFO] NSSM missing; running winget because -InstallNssm was set." -ForegroundColor Yellow
        winget install --id NSSM.NSSM -e --accept-package-agreements --accept-source-agreements
        $NssmPath = Find-Nssm
    }
    if (-not $NssmPath) {
        Write-Host "[ERROR] NSSM not found. Place nssm.exe on PATH, C:\tools\nssm, or Program Files," -ForegroundColor Red
        Write-Host "        or re-run with -Install -InstallNssm." -ForegroundColor Red
        exit 1
    }
}

if ($Runner.Missing) {
    Write-Host "[WARN] headless_job_runner.py is still missing; registering the intended path anyway." -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$existingHeadless = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingHeadless) {
    Write-Host "[INFO] Updating existing $ServiceName only." -ForegroundColor Gray
    & $NssmPath stop $ServiceName | Out-Null
    & $NssmPath remove $ServiceName confirm | Out-Null
}

$protected = Get-Service -Name $ProtectedService -ErrorAction SilentlyContinue
if ($protected) {
    Write-Host "[OK]    $ProtectedService remains $($protected.Status) (untouched)." -ForegroundColor Green
}

& $NssmPath install $ServiceName $PythonPath "-u `"$($Runner.ScriptPath)`""
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] nssm install $ServiceName failed with exit $LASTEXITCODE." -ForegroundColor Red
    exit 1
}

& $NssmPath set $ServiceName AppDirectory $Runner.AppDirectory
& $NssmPath set $ServiceName Description "Hybrid headless job runner ($BindNote)"
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName AppStdout $StdoutLog
& $NssmPath set $ServiceName AppStderr $StderrLog
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateOnline 1
& $NssmPath set $ServiceName AppRotateBytes 10485760
& $NssmPath set $ServiceName AppRotateSeconds 86400
& $NssmPath set $ServiceName AppThrottle 1500
& $NssmPath set $ServiceName AppRestartDelay 5000
& $NssmPath set $ServiceName AppEnvironmentExtra "PYTHONUNBUFFERED=1"

if ($Start) {
    Write-Host "[INFO] Starting $ServiceName because -Start was set." -ForegroundColor Yellow
    & $NssmPath start $ServiceName
} else {
    Write-Host "[INFO] $ServiceName registered but not started (pass -Start to start)." -ForegroundColor Gray
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "[SUCCESS] $ServiceName configured. Bind $BindNote. $ProtectedService was not touched." -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
