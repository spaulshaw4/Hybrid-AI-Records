<#
.SYNOPSIS
    LANDR pack intake: unzip incoming_zips -> slice raw_packs -> index corpus_4s -> pack_manifest.
.DESCRIPTION
    Default is -DryRun. Pass -Execute for live unzip / slice / index.

    Copy LANDR zip files into D:\MusicDatasets\incoming_zips. Default scan is
    incoming_zips only -- this script never passes --also-scan-root, never unzips
    D:\MusicDatasets\*.zip (fma_full.zip and the multi-GB LANDR-20260830-*.zip
    archives at the dataset root stay untouched).

    Slicer --input is D:\MusicDatasets\raw_packs (or per-pack UNZIPPED dirs under
    it). Never D:\, never D:\MusicDatasets, never uploaded_slices, never
    LANDR-20260830-* folders already sitting at the dataset root.

    Indexer is db\index_578gb_corpus.py (numpy/scipy; no CQT unless HYBRID_USE_LIBROSA=1).
    corpus_4s already has ~52k wavs. DryRun does not write slice_index.
    Execute without -Limit does NOT start --full (hours). Prefer -Limit for smoke.
    READY_TO_GO is only set after a successful unlimited index of SLICED packs.

    Python is Get-HybridPython (never Store stub / D:\MusicDatasets\venv).
    Does not run scripts\local_slicer.py. Does not replace run_master_pipeline.ps1.
.PARAMETER DryRun
    List incoming zips, slicer --dry-run if raw_packs has audio, no slice_index writes.
    This is the default.
.PARAMETER Execute
    Unzip PENDING packs, slice UNZIPPED raw_packs, optionally smoke-index with -Limit.
.PARAMETER Workers
    Slicer and indexer pool size. Default 8.
.PARAMETER Limit
    Cap slicer source files and indexer wavs this run (test smoke). 0 = no cap
    for the slicer; indexer still refuses an overnight --full.
.PARAMETER BaseDir
    Dataset root. Default D:\MusicDatasets.
.EXAMPLE
    .\ingest_landr_packs.ps1
    .\ingest_landr_packs.ps1 -Execute -Limit 8 -Workers 8
#>

param(
    [switch]$DryRun,
    [switch]$Execute,
    [int]$Workers = 8,
    [int]$Limit = 0,
    [string]$BaseDir = "D:\MusicDatasets"
)

$ErrorActionPreference = "Stop"
$doWork = [bool]$Execute
if (-not $Execute -and -not $DryRun) { $DryRun = $true }

$Incoming = Join-Path $BaseDir "incoming_zips"
$RawPacks = Join-Path $BaseDir "raw_packs"
$SliceOut = Join-Path $BaseDir "corpus_4s"
$DbPath = Join-Path $BaseDir "db\corpus_index.sqlite"
if ($Workers -le 0) { $Workers = 8 }

$ScriptsDir = $PSScriptRoot
$ParentDir = Split-Path $ScriptsDir -Parent
$Workstation = "D:\MusicDatasets"
$WorkstationScripts = Join-Path $Workstation "scripts"

$resolveHere = Join-Path $ScriptsDir "resolve_python.ps1"
$resolveD = Join-Path $WorkstationScripts "resolve_python.ps1"
if (Test-Path $resolveHere) { . $resolveHere }
elseif (Test-Path $resolveD) { . $resolveD }
else { throw "resolve_python.ps1 not found next to this script or at $resolveD" }

$python = Get-HybridPython -Quiet
if (-not $python) {
    throw "Get-HybridPython found no usable interpreter (WindowsApps stubs are rejected)."
}
if ($python -match '\\venv\\|\\WindowsApps\\') {
    throw "Refusing interpreter '$python' (venv / Store stub)."
}

function Resolve-CodeRoot {
    param([string]$Parent)
    foreach ($candidate in @($Parent, $Workstation)) {
        if ((Test-Path (Join-Path $candidate "db\pack_tracker.py")) -or
            (Test-Path (Join-Path $candidate "engine\smart_transient_slicer.py"))) {
            return $candidate
        }
    }
    return $Parent
}

$CodeRoot = Resolve-CodeRoot -Parent $ParentDir
$env:PYTHONPATH = $CodeRoot
$env:HYBRID_USE_LIBROSA = "0"

function Copy-WorkstationBits {
    if ($CodeRoot -eq $Workstation) { return }
    $pairs = @(
        @{ Src = Join-Path $CodeRoot "engine\smart_transient_slicer.py"; Dst = Join-Path $Workstation "engine\smart_transient_slicer.py" },
        @{ Src = Join-Path $CodeRoot "dsp\smart_transient_slicer.py"; Dst = Join-Path $Workstation "dsp\smart_transient_slicer.py" },
        @{ Src = Join-Path $CodeRoot "db\index_578gb_corpus.py"; Dst = Join-Path $Workstation "db\index_578gb_corpus.py" },
        @{ Src = Join-Path $CodeRoot "db\pack_tracker.py"; Dst = Join-Path $Workstation "db\pack_tracker.py" },
        @{ Src = Join-Path $CodeRoot "db\__init__.py"; Dst = Join-Path $Workstation "db\__init__.py" },
        @{ Src = Join-Path $ScriptsDir "ingest_landr_packs.ps1"; Dst = Join-Path $WorkstationScripts "ingest_landr_packs.ps1" },
        @{ Src = Join-Path $ScriptsDir "resolve_python.ps1"; Dst = Join-Path $WorkstationScripts "resolve_python.ps1" }
    )
    foreach ($pair in $pairs) {
        if (-not (Test-Path $pair.Src)) { continue }
        $destDir = Split-Path $pair.Dst -Parent
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item -LiteralPath $pair.Src -Destination $pair.Dst -Force
        Write-Host "  [COPY] $($pair.Dst)" -ForegroundColor Gray
    }
}

function Get-SlicerPath {
    $engine = Join-Path $CodeRoot "engine\smart_transient_slicer.py"
    $dsp = Join-Path $CodeRoot "dsp\smart_transient_slicer.py"
    if (Test-Path $engine) { return $engine }
    if (Test-Path $dsp) { return $dsp }
    throw "No smart_transient_slicer.py under engine\ or dsp\ in $CodeRoot"
}

function Get-IndexerPath {
    $idx = Join-Path $CodeRoot "db\index_578gb_corpus.py"
    if (-not (Test-Path $idx)) { throw "Missing indexer: $idx" }
    return $idx
}

function Get-TrackerPath {
    $tr = Join-Path $CodeRoot "db\pack_tracker.py"
    if (-not (Test-Path $tr)) { throw "Missing pack tracker: $tr" }
    return $tr
}

function Test-ForbiddenSlicerInput {
    param([string]$Path)
    if (-not $Path) { return $true }
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $forbidden = @(
        "D:",
        "D:\",
        $BaseDir.TrimEnd('\'),
        (Join-Path $BaseDir "uploaded_slices"),
        (Join-Path $BaseDir "corpus_4s")
    )
    foreach ($bad in $forbidden) {
        $b = [System.IO.Path]::GetFullPath($bad).TrimEnd('\')
        if ($full -eq $b) { return $true }
    }
    return $false
}

function Test-DirHasAudio {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $hit = Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -match '\.(wav|flac|aif|aiff)$' } |
        Select-Object -First 1
    return [bool]$hit
}

function Get-TrackerPaths {
    param([string]$Status)
    $raw = & $python $tracker "--db" $DbPath "--print-paths" $Status 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    $paths = @()
    foreach ($line in @($raw)) {
        $p = "$line".Trim()
        if ($p) { $paths += $p }
    }
    return $paths
}

function Get-PackNameFromRawPath {
    param([string]$Path)
    return [System.IO.Path]::GetFileName($Path.TrimEnd('\'))
}

function Read-SlicerWritten {
    param([string]$Text)
    if ($Text -match 'written=(\d+)') { return [int]$Matches[1] }
    if ($Text -match 'would_write=(\d+)') { return [int]$Matches[1] }
    return 0
}

foreach ($dir in @($Incoming, $RawPacks)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "  [CREATE] $dir" -ForegroundColor Green
    }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "LANDR PACK INTAKE  ($BaseDir)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ("Mode     : {0}" -f $(if ($doWork) { "EXECUTE" } else { "DRY-RUN (default)" }))
Write-Host "Python   : $python"
Write-Host "CodeRoot : $CodeRoot"
Write-Host "Incoming : $Incoming"
Write-Host "RawPacks : $RawPacks"
Write-Host "SliceOut : $SliceOut"
Write-Host "Index DB : $DbPath"
Write-Host "Workers  : $Workers"
Write-Host ("Limit    : {0}" -f $(if ($Limit -gt 0) { $Limit } else { "none (indexer will not --full)" }))
Write-Host "Note     : Copy LANDR zips into incoming_zips. Top-level D:\MusicDatasets\*.zip are not scanned."

Write-Host "`nWORKSTATION COPIES:" -ForegroundColor Yellow
Copy-WorkstationBits

$tracker = Get-TrackerPath
$slicer = Get-SlicerPath
$indexer = Get-IndexerPath
Write-Host "Tracker  : $tracker"
Write-Host "Slicer   : $slicer"
Write-Host "Indexer  : $indexer"

$unzipOk = $false
$sliceOk = $false
$indexOk = $false
$readyOk = $false
$sliceRan = $false
$indexRan = $false

# --- Step 1: pack_tracker (incoming_zips only, never --also-scan-root) ---
Write-Host "`nSTEP 1  UNZIP / LEDGER:" -ForegroundColor Yellow
$trackArgs = @(
    $tracker,
    "--incoming", $Incoming,
    "--raw-packs", $RawPacks,
    "--db", $DbPath,
    "--dataset-root", $BaseDir
)
if (-not $doWork) { $trackArgs += "--dry-run" }
Write-Host ("  > {0} {1}" -f $python, ($trackArgs -join " "))
& $python @trackArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [WARN] pack_tracker exit $LASTEXITCODE" -ForegroundColor Yellow
} else {
    $unzipOk = $true
}

# --- Step 2: slicer (raw_packs / UNZIPPED pack dirs only) ---
Write-Host "`nSTEP 2  SLICE:" -ForegroundColor Yellow
$sliceTargets = @()
if ($doWork) {
    foreach ($p in @(Get-TrackerPaths -Status "UNZIPPED")) {
        if ((Test-Path -LiteralPath $p) -and (Test-DirHasAudio -Path $p) -and -not (Test-ForbiddenSlicerInput -Path $p)) {
            $sliceTargets += $p
        }
    }
}
if ($sliceTargets.Count -eq 0 -and (Test-DirHasAudio -Path $RawPacks) -and -not (Test-ForbiddenSlicerInput -Path $RawPacks)) {
    $sliceTargets += $RawPacks
}

if (Test-ForbiddenSlicerInput -Path $RawPacks) {
    Write-Host "  [SKIP] raw_packs path is forbidden as slicer --input." -ForegroundColor Yellow
    $sliceTargets = @()
}

if ($sliceTargets.Count -eq 0) {
    if (-not (Test-Path -LiteralPath $RawPacks)) {
        Write-Host '  [SKIP] raw_packs missing. Not falling back to D:\ root, incoming, or LANDR-20260830-* trees.'
    } elseif (-not (Test-DirHasAudio -Path $RawPacks)) {
        Write-Host '  [SKIP] raw_packs has no wav/flac/aif. Not falling back to D:\ root, incoming, or LANDR-20260830-* trees.'
    } else {
        Write-Host "  [SKIP] no safe UNZIPPED pack dirs to slice."
    }
} else {
    $remaining = $Limit
    foreach ($target in $sliceTargets) {
        if (Test-ForbiddenSlicerInput -Path $target) {
            Write-Host "  [SKIP] forbidden slicer --input $target"
            continue
        }
        $argList = @(
            $slicer,
            "--input", $target,
            "--output", $SliceOut,
            "--workers", [string]$Workers
        )
        if (-not $doWork) { $argList += "--dry-run" }
        if ($Limit -gt 0) {
            if ($remaining -le 0) {
                Write-Host ("  [SKIP] -Limit exhausted; not slicing {0}" -f $target)
                continue
            }
            $argList += @("--limit", [string]$remaining)
        }
        Write-Host ("  > {0} {1}" -f $python, ($argList -join " "))
        $slicerLog = & $python @argList 2>&1 | ForEach-Object { "$_" }
        $slicerLog | ForEach-Object { Write-Host "    $_" }
        $sliceRan = $true
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [WARN] slicer exit $LASTEXITCODE for $target" -ForegroundColor Yellow
            $sliceOk = $false
            if ($doWork) {
                $failedName = Get-PackNameFromRawPath -Path $target
                & $python $tracker "--db" $DbPath "--set-failed" $failedName | ForEach-Object { Write-Host "    $_" }
            }
            continue
        }
        if ($doWork -and $Limit -le 0) {
            $written = Read-SlicerWritten -Text ($slicerLog -join "`n")
            $packName = Get-PackNameFromRawPath -Path $target
            if ($target -eq $RawPacks) {
                & $python $tracker "--db" $DbPath "--advance-sliced-all" "--slice-count" ([string]$written) |
                    ForEach-Object { Write-Host "    $_" }
            } else {
                & $python $tracker "--db" $DbPath "--advance-sliced" $packName "--slice-count" ([string]$written) |
                    ForEach-Object { Write-Host "    $_" }
            }
            $sliceOk = $true
        } elseif ($doWork -and $Limit -gt 0) {
            $written = Read-SlicerWritten -Text ($slicerLog -join "`n")
            Write-Host ('  [INFO] slicer wrote={0} under -Limit {1}; not marking SLICED (partial).' -f $written, $Limit)
            if ($remaining -gt 0) { $remaining -= $Limit }
            $sliceOk = $true
        } else {
            $sliceOk = $true
        }
    }
}

# --- Step 3: indexer (never --full 52k in a casual run) ---
Write-Host "`nSTEP 3  INDEX (numpy/scipy; no CQT in the default path):" -ForegroundColor Yellow
Write-Host "  corpus_4s already holds tens of thousands of wavs (~52,588)."
Write-Host "  Both workstation sqlite files keep existing slice_index rows; this script does not delete them."
Write-Host ('  Indexer INSERT OR REPLACE does not skip existing file_path. A run without -Limit would need --full and take hours.')

if (-not $doWork) {
    Write-Host '  [DRY-RUN] no slice_index writes. A live run without -Limit would need --full and take hours.'
    Write-Host ("  documented overnight (do not start casually): {0} {1} --corpus {2} --db {3} --workers {4} --full" -f $python, $indexer, $SliceOut, $DbPath, $Workers)
} elseif ($Limit -gt 0) {
    $indexArgs = @(
        $indexer,
        "--corpus", $SliceOut,
        "--db", $DbPath,
        "--workers", [string]$Workers,
        "--limit", [string]$Limit
    )
    Write-Host ("  > {0} {1}" -f $python, ($indexArgs -join " "))
    & $python @indexArgs
    $indexRan = $true
    if ($LASTEXITCODE -eq 0) {
        $indexOk = $true
        Write-Host ('  [INFO] smoke index --limit {0} succeeded; not marking READY_TO_GO (partial corpus).' -f $Limit)
    } else {
        Write-Host "  [WARN] indexer exit $LASTEXITCODE" -ForegroundColor Yellow
    }
} else {
    Write-Host '  [SKIP] refusing overnight --full of ~52k wavs. Pass -Limit N for a smoke index.'
    Write-Host ("  documented overnight: {0} {1} --corpus {2} --db {3} --workers {4} --full" -f $python, $indexer, $SliceOut, $DbPath, $Workers)
}

# --- Step 4: READY_TO_GO only after successful unlimited index of SLICED packs ---
Write-Host "`nSTEP 4  READY_TO_GO:" -ForegroundColor Yellow
if (-not $doWork) {
    Write-Host "  [DRY-RUN] pack_manifest is not updated to READY_TO_GO."
} elseif ($indexOk -and $sliceOk -and $Limit -le 0 -and $indexRan) {
    & $python $tracker "--db" $DbPath "--advance-ready" | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -eq 0) { $readyOk = $true }
} else {
    Write-Host '  [SKIP] READY_TO_GO only after Execute slice + a complete index of SLICED packs (no -Limit, no skipped --full).'
}

Write-Host "`n================================================================" -ForegroundColor Cyan
$allDone = $doWork -and $unzipOk -and $sliceOk -and $indexOk -and $readyOk -and $sliceRan -and $indexRan
if ($allDone) {
    Write-Host "[COMPLETE] LANDR pack intake finished (READY_TO_GO)." -ForegroundColor Green
} elseif (-not $doWork) {
    Write-Host "DRY-RUN finished. Copy LANDR zips into incoming_zips, then:" -ForegroundColor Green
    Write-Host ('  powershell -NoProfile -File "{0}" -Execute -Workers 8 -Limit 8' -f $PSCommandPath)
    Write-Host '  (smoke). A later unlimited Execute still will not --full 52k; run the documented indexer --full overnight, then --advance-ready.'
} else {
    Write-Host "Execute finished with skipped or partial steps (see above). Not claiming all packs ready." -ForegroundColor Yellow
}
Write-Host "================================================================" -ForegroundColor Cyan

exit 0
