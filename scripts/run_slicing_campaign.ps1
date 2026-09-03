<#
.SYNOPSIS
    Resumable, ledger-tracked bulk 4s slicing campaign over the raw D: library.
.DESCRIPTION
    Wraps scripts\run_slicing_campaign.py. Dry-run is the default; -Execute is
    required before any audio is written.

    The ledger lives in D:\MusicDatasets\db\corpus_index.sqlite in its own
    campaign_* tables. Re-running skips everything already DONE or SKIPPED, so
    the campaign survives a crash, a reboot or a Ctrl-C.

    Worker count is chosen automatically. While the corpus indexer is running
    the ceiling is 2; otherwise it is 8. It never exceeds cpu_count.
.PARAMETER Execute
    Write slices and copy one-shots. Without it the run is a dry-run that
    prints the plan, lists incoming_zips, and leaves the ledger PENDING.
.PARAMETER Limit
    Process at most N source files. Use for smoke tests.
.PARAMETER Source
    Restrict discovery and slicing to one top-level source tree, e.g. "mtg".
    Required (with -Limit) for a smoke test. Never pass D:\ or D:\MusicDatasets.
.PARAMETER Status
    Print one status line (percent, throughput, ETA) and exit.
.PARAMETER Plan
    Scan and print the estimate table, then stop without slicing.
.PARAMETER ListZips
    List incoming_zips without extracting. Dry-run already does this.
    fma_full.zip is never extracted.
.EXAMPLE
    .\run_slicing_campaign.ps1 -Plan
    .\run_slicing_campaign.ps1 -Source "90's MPC Sample Pack" -Execute -Limit 8
    .\run_slicing_campaign.ps1 -Execute
    .\run_slicing_campaign.ps1 -Status
#>

param(
    [switch]$Execute,
    [switch]$Plan,
    [switch]$Status,
    [switch]$RetryFailed,
    [switch]$NoScan,
    [switch]$WaitForIndexer,
    [switch]$AllowContention,
    [switch]$ListZips,
    [switch]$Verbose,
    [int]$Limit = 0,
    [int]$Workers = 0,
    [int]$BatchSize = 0,
    [string]$Source = "",
    [string]$Campaign = "corpus_4s_bulk",
    [string]$Root = "D:\MusicDatasets",
    [string]$Output = "D:\MusicDatasets\corpus_4s",
    [string]$OneshotOutput = "D:\MusicDatasets\oneshots",
    [string]$IncomingZips = "D:\MusicDatasets\incoming_zips",
    [string]$Database = "D:\MusicDatasets\db\corpus_index.sqlite",
    [string]$LogDir = "D:\MusicDatasets\logs",
    [string]$PythonExe = "C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PythonExe)) {
    throw "Python 3.12 not found at $PythonExe. This campaign does not use a venv or the Store interpreter."
}

$RepoRoot = Split-Path $PSScriptRoot -Parent
$Driver = Join-Path $PSScriptRoot "run_slicing_campaign.py"
if (-not (Test-Path $Driver)) {
    throw "Driver not found: $Driver"
}

# Refuse the drive root and denied trees outright, before Python sees them.
$normalizedRoot = $Root.TrimEnd('\')
if ($normalizedRoot -match '^[A-Za-z]:$') {
    throw "Refusing to use $Root as the campaign root. Pass a source tree, not a drive root."
}
$deniedRoots = @(
    'uploaded_slices', 'corpus_4s', 'scratch', 'renders', 'oneshots',
    'incoming_zips', 'releases', 'archive', 'logs', 'db', 'database'
)
$rootLeaf = Split-Path $normalizedRoot -Leaf
if ($deniedRoots -contains $rootLeaf) {
    throw "Refusing to use $Root as the campaign root (denied tree). Never slice uploaded_slices, corpus_4s, scratch, or renders."
}

$campaignArgs = @(
    $Driver,
    "--root", $Root,
    "--output", $Output,
    "--oneshot-output", $OneshotOutput,
    "--incoming-zips", $IncomingZips,
    "--db", $Database,
    "--campaign", $Campaign,
    "--log-dir", $LogDir
)

if ($Source)          { $campaignArgs += @("--source", $Source) }
if ($Limit -gt 0)     { $campaignArgs += @("--limit", $Limit) }
if ($Workers -gt 0)   { $campaignArgs += @("--workers", $Workers) }
if ($BatchSize -gt 0) { $campaignArgs += @("--batch-size", $BatchSize) }
if ($Execute)         { $campaignArgs += "--execute" }
if ($Plan)            { $campaignArgs += "--plan" }
if ($Status)          { $campaignArgs += "--status" }
if ($NoScan)          { $campaignArgs += "--no-scan" }
if ($RetryFailed)     { $campaignArgs += "--retry-failed" }
if ($WaitForIndexer)  { $campaignArgs += "--wait-for-indexer" }
if ($AllowContention) { $campaignArgs += "--allow-contention" }
if ($ListZips)        { $campaignArgs += "--list-zips" }
if ($Verbose)         { $campaignArgs += "--verbose" }

if (-not $Status) {
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "BULK 4s SLICING CAMPAIGN" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "Mode     : $(if ($Execute) { '[EXECUTE - WRITES AUDIO]' } else { '[DRY RUN - PLAN ONLY, NO WRITES]' })"
    Write-Host "Campaign : $Campaign"
    Write-Host "Root     : $Root"
    Write-Host "Output   : $Output"
    Write-Host "Oneshots : $OneshotOutput"
    Write-Host "Zips     : $IncomingZips (list only; never extract fma_full.zip)"
    Write-Host "Ledger   : $Database"
    if ($Source) { Write-Host "Source   : $Source" }
    if ($Limit -gt 0) { Write-Host "Limit    : $Limit files" }
    Write-Host "================================================================" -ForegroundColor Cyan
}

$env:PYTHONPATH = $RepoRoot
& $PythonExe @campaignArgs
$code = $LASTEXITCODE

if ($code -eq 130) {
    Write-Host "`nInterrupted. Progress is in the ledger - re-run the same command to resume." -ForegroundColor Yellow
} elseif ($code -ne 0) {
    Write-Host "`nCampaign exited with code $code." -ForegroundColor Red
} elseif (-not $Status -and -not $Plan) {
    Write-Host "`nCheck progress any time with:" -ForegroundColor Green
    Write-Host "  .\run_slicing_campaign.ps1 -Status" -ForegroundColor Green
}

exit $code
