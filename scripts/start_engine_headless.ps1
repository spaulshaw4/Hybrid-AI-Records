<#
.SYNOPSIS
    Validate the D: headless engine. Does not start a server unless -Start.
.DESCRIPTION
    Scaffolds dirs, resolves Get-HybridPython (never Start-Process python),
    warns if REPLICATE_API_TOKEN is missing (offline is OK), and checks the
    corpus index. Default is validate-only. -Start launches
    api/headless_job_runner.py in a visible window on 127.0.0.1:8000.
    This script does not install NSSM.
#>
[CmdletBinding()]
param(
    [switch]$Start,
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$BindHost = "127.0.0.1",
    [int]$BindPort = 8000
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ResolvePython = Join-Path $PSScriptRoot "resolve_python.ps1"
if (-not (Test-Path $ResolvePython)) {
    $ResolvePython = Join-Path $BaseDir "scripts\resolve_python.ps1"
}
if (-not (Test-Path $ResolvePython)) {
    Write-Host "[ERROR] resolve_python.ps1 not found" -ForegroundColor Red
    exit 1
}
. $ResolvePython
$python = Get-HybridPython
if (-not $python) { throw "Python interpreter not resolvable (Get-HybridPython)." }

$dirs = @(
    "db", "scratch", "releases", "releases\assets", "logs", "corpus_4s",
    "engine", "dsp", "api", "scripts", "database"
)
foreach ($rel in $dirs) {
    $path = Join-Path $BaseDir $rel
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path | Out-Null
        Write-Host "[MKDIR] $path"
    } else {
        Write-Host "[OK]    $path"
    }
}

$token = $env:REPLICATE_API_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Host '[WARN] REPLICATE_API_TOKEN missing - offline heuristic arrange is OK' -ForegroundColor Yellow
} else {
    Write-Host '[OK]   REPLICATE_API_TOKEN present - live arrange available'
}

$dbCandidates = @(
    (Join-Path $BaseDir "db\corpus_index.sqlite"),
    (Join-Path $BaseDir "database\corpus_index.sqlite")
)
$dbFound = $dbCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $dbFound) {
    $create = Join-Path $BaseDir "db\corpus_index.sqlite"
    $null = New-Item -ItemType File -Path $create -Force
    Write-Host "[WARN] corpus index missing - created empty $create"
    Write-Host "       Run indexer with --limit 25 --workers 2 --db $create"
} else {
    Write-Host "[OK]   corpus index $dbFound"
}

$runner = Join-Path $BaseDir "api\headless_job_runner.py"
if (-not (Test-Path $runner)) {
    $runner = Join-Path $RepoRoot "api\headless_job_runner.py"
}

Write-Host "[STATUS] python=$python"
Write-Host "[STATUS] runner=$runner"
Write-Host "[STATUS] bind=${BindHost}:${BindPort}"
Write-Host "[STATUS] default is validate-only (no background server)"

if (-not $Start) {
    Write-Host "[VALIDATE] not starting headless_job_runner. Pass -Start for a visible window."
    exit 0
}

if (-not (Test-Path $runner)) {
    Write-Host "[ERROR] headless_job_runner.py not found" -ForegroundColor Red
    exit 1
}

Write-Host "[START] visible CPU API: $python $runner --host $BindHost --port $BindPort --workers 2 -d cpu"
$argList = @(
    "-NoExit",
    "-Command",
    "`$env:CUDA_VISIBLE_DEVICES=''; `$env:HYBRID_INFER_DEVICE='cpu'; & '$python' '$runner' --host $BindHost --port $BindPort --workers 2 -d cpu"
)
Start-Process -FilePath "powershell.exe" -ArgumentList $argList
exit 0
