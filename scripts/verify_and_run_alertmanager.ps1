<#
.SYNOPSIS
    Validates the Hybrid 1.0 Alertmanager config, then starts Alertmanager.
.DESCRIPTION
    Runs amtool check-config first and aborts on failure, so a malformed
    routing tree is caught before the process starts and silently drops alerts.
.PARAMETER ToolsDir
    Folder containing alertmanager.exe and amtool.exe. Defaults to PATH lookup.
.PARAMETER ConfigFile
    Path to alertmanager.yml.
.PARAMETER BindAddress
    Listen address. Defaults to loopback - see the note below before widening it.
#>

param(
    [string]$ToolsDir = "",
    [string]$ConfigFile = "D:\MusicDatasets\config\alertmanager.yml",
    [string]$BindAddress = "127.0.0.1:9093"
)

$ErrorActionPreference = "Stop"

function Resolve-Tool {
    param([string]$Name)

    if ($ToolsDir) {
        $candidate = Join-Path $ToolsDir "$Name.exe"
        if (Test-Path $candidate) { return $candidate }
        throw "$Name.exe not found in -ToolsDir '$ToolsDir'."
    }

    $cmd = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $localCandidate = Join-Path $PWD "$Name.exe"
    if (Test-Path $localCandidate) { return $localCandidate }

    throw "$Name.exe not found in PATH or current directory. Pass -ToolsDir to point at the Alertmanager install folder."
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - ALERTMANAGER VALIDATION & LAUNCH" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Config : $ConfigFile"
Write-Host "Bind   : $BindAddress"
Write-Host "================================================================" -ForegroundColor Cyan

if (!(Test-Path $ConfigFile)) {
    Write-Host "[ERROR] Config file not found: $ConfigFile" -ForegroundColor Red
    Write-Host "        Run deploy_to_workstation.ps1 to sync monitoring configs to D:\MusicDatasets\config." -ForegroundColor Yellow
    exit 1
}

$amtool = Resolve-Tool -Name "amtool"
$alertmanager = Resolve-Tool -Name "alertmanager"

# 1. Validate syntax with amtool
Write-Host "`n[1/2] Validating routing tree with amtool..." -ForegroundColor Yellow
& $amtool check-config $ConfigFile

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] amtool rejected the config (exit code $LASTEXITCODE). Not starting Alertmanager." -ForegroundColor Red
    exit 1
}

Write-Host "  -> Config valid." -ForegroundColor Green

# 2. Run Alertmanager
Write-Host "`n[2/2] Starting Alertmanager on $BindAddress..." -ForegroundColor Yellow

if ($BindAddress -notlike "127.0.0.1:*" -and $BindAddress -notlike "localhost:*") {
    Write-Host "[WARN] Binding beyond loopback. Alertmanager has no built-in authentication," -ForegroundColor Yellow
    Write-Host "       and its API permits creating silences, so anyone who can reach this" -ForegroundColor Yellow
    Write-Host "       port can suppress every alert in the stack. Put an authenticating" -ForegroundColor Yellow
    Write-Host "       reverse proxy in front instead of widening the bind." -ForegroundColor Yellow
}

& $alertmanager --config.file="$ConfigFile" --web.listen-address="$BindAddress"
