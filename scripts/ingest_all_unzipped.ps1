<#
.SYNOPSIS
    Discover, phrase-slice, and index unzipped sample packs under D:\MusicDatasets.
.DESCRIPTION
    Default is -DryRun (counts only). Pass -Execute to slice and index.

    Never walks uploaded_slices / corpus_4s / archive / renders as sources.
    Never passes D:\MusicDatasets as slicer --input. Candidate dirs (raw_packs,
    raw_stems, incoming full-length, LANDR packs, other unzipped trees) are
    passed one --input each to engine\smart_transient_slicer.py.

    Python is Get-HybridPython (never venv / Store stub).
    Indexer: db\index_578gb_corpus.py (numpy/scipy; no librosa).
    Does not run scripts\local_slicer.py. Does not modify run_master_pipeline.ps1.
.PARAMETER DryRun
    List discovery counts and the slice/index plan. This is the default.
.PARAMETER Execute
    Perform slicing and indexing.
.PARAMETER Limit
    Max source files for the slicer this run. 0 = auto (all if <=200 raw files;
    first 50 if more than 500).
.PARAMETER IndexLimit
    Max wavs for the foreground indexer. 0 = 200 (smoke / upsert batch).
.PARAMETER Workers
    Slicer and indexer pool size. Hardcoded default 8. Override with -Workers.
.PARAMETER BaseDir
    Dataset root. Default D:\MusicDatasets.
.EXAMPLE
    .\ingest_all_unzipped.ps1
    .\ingest_all_unzipped.ps1 -Execute -Input "D:\MusicDatasets\raw_packs" -Workers 8
#>

param(
    [switch]$DryRun,
    [switch]$Execute,
    [int]$Limit = 0,
    [int]$IndexLimit = 0,
    [int]$Workers = 8,
    [string]$BaseDir = "D:\MusicDatasets"
)

$ErrorActionPreference = "Stop"
$doWork = [bool]$Execute
if (-not $Execute -and -not $DryRun) { $DryRun = $true }

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
        if ((Test-Path (Join-Path $candidate "engine\smart_transient_slicer.py")) -or
            (Test-Path (Join-Path $candidate "dsp\smart_transient_slicer.py"))) {
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
        @{ Src = Join-Path $CodeRoot "engine\smart_transient_slicer.py"; Dst = Join-Path $Workstation "engine\smart_transient_slicer.py"; Always = $true },
        @{ Src = Join-Path $CodeRoot "dsp\smart_transient_slicer.py"; Dst = Join-Path $Workstation "dsp\smart_transient_slicer.py"; Always = $false },
        @{ Src = Join-Path $CodeRoot "db\index_578gb_corpus.py"; Dst = Join-Path $Workstation "db\index_578gb_corpus.py"; Always = $false },
        @{ Src = Join-Path $CodeRoot "db\__init__.py"; Dst = Join-Path $Workstation "db\__init__.py"; Always = $false },
        @{ Src = Join-Path $CodeRoot "db\sample_indexer.py"; Dst = Join-Path $Workstation "db\sample_indexer.py"; Always = $false },
        @{ Src = Join-Path $ScriptsDir "ingest_all_unzipped.ps1"; Dst = Join-Path $WorkstationScripts "ingest_all_unzipped.ps1"; Always = $true }
    )
    foreach ($pair in $pairs) {
        if (-not (Test-Path $pair.Src)) { continue }
        $destDir = Split-Path $pair.Dst -Parent
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        if ($pair.Always -or -not (Test-Path $pair.Dst)) {
            Copy-Item -LiteralPath $pair.Src -Destination $pair.Dst -Force
            Write-Host "  [COPY] $($pair.Dst)" -ForegroundColor Gray
        }
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

function Get-IndexWorkers {
    param([int]$Requested)
    if ($Requested -gt 0) { return $Requested }
    return 8
}

function Get-SqliteCount {
    param([string]$DbPath)
    if (-not (Test-Path $DbPath)) { return 0 }
    $code = "import sqlite3,sys`ntry:`n c=sqlite3.connect(sys.argv[1])`n print(int(c.execute('SELECT COUNT(*) FROM slice_index').fetchone()[0]))`n c.close()`nexcept Exception:`n print(0)"
    $out = & $python -c $code $DbPath
    try { return [int]"$out".Trim() } catch { return 0 }
}

$discoverPy = @'
import json, os, re, sys
import numpy as np
try:
    import soundfile as sf
except Exception:
    sf = None

base = os.path.abspath(sys.argv[1])
AUDIO_COUNT = {".wav", ".flac", ".mp3", ".aif", ".aiff"}
AUDIO_SLICE = {".wav", ".flac", ".aif", ".aiff"}
PHRASE_RE = re.compile(r"(_phrase_|_slice_)", re.I)
SKIP = {
    "corpus_4s", "scratch", "releases", "node_modules", ".git",
    "uploaded_slices", "uploaded_slice", "archive", "renders", "logs",
    "database", "db", "models", "venv", ".venv", "scripts", "config",
    "monitoring", "api", "dsp", "engine", "server", "src", "tests",
    "__pycache__", "completed_raw", "spliced_staging", "distribution_exports",
    "job_payloads", ".index",
}
ALREADY = {"dsd100", "musdb18", "musdb18hq", "medley", "medleydb"}
PREFERRED = {"raw_packs", "raw_stems"}
DEEP_WALK_PREFIXES = ("raw_", "landr")
DEEP_WALK_NAMES = PREFERRED | {"incoming"}

def zero():
    return {"wav": 0, "flac": 0, "mp3": 0, "aif": 0, "total": 0}

def count_ext(name, bucket):
    ext = os.path.splitext(name)[1].lower()
    if ext == ".wav":
        bucket["wav"] += 1
    elif ext == ".flac":
        bucket["flac"] += 1
    elif ext == ".mp3":
        bucket["mp3"] += 1
    elif ext in {".aif", ".aiff"}:
        bucket["aif"] += 1

def probe(files, n=12):
    durs = []
    if sf is None:
        return durs
    for path in files[:n]:
        try:
            durs.append(float(sf.info(path).duration))
        except Exception:
            pass
    return durs

def sliced_incoming(files, durs):
    if not files:
        return False
    named = sum(1 for p in files if PHRASE_RE.search(os.path.basename(p)))
    if named / max(1, min(len(files), 80)) >= 0.5:
        return True
    if len(durs) >= 3 and sum(1 for d in durs if 0.85 <= d <= 1.15) >= max(3, (len(durs) * 2) // 3):
        return True
    return False

if not os.path.isdir(base):
    json.dump({"base": base, "by_top": {}, "candidates": [], "skipped": [{"path": base, "reason": "missing", "files": 0}], "excluded_present": [], "corpus_4s_wavs": 0, "totals": zero()}, sys.stdout)
    raise SystemExit(0)

excluded_present = []
try:
    for name in os.listdir(base):
        if name.lower() in SKIP or name.lower() in ALREADY:
            excluded_present.append(name)
except OSError:
    pass

files_by_top = {}
try:
    top_names = sorted(os.listdir(base))
except OSError:
    top_names = []

for top in top_names:
    top_path = os.path.join(base, top)
    if not os.path.isdir(top_path):
        continue
    top_l = top.lower()
    if top_l in SKIP or top_l in ALREADY:
        continue
    deep = top_l in DEEP_WALK_NAMES or any(top_l.startswith(p) for p in DEEP_WALK_PREFIXES)
    bucket = files_by_top.setdefault(top, [])
    if deep:
        for root, dirs, files in os.walk(top_path):
            dirs[:] = [d for d in dirs if d.lower() not in SKIP]
            for name in files:
                if os.path.splitext(name)[1].lower() in AUDIO_COUNT:
                    bucket.append(os.path.join(root, name))
    else:
        try:
            for name in os.listdir(top_path):
                child = os.path.join(top_path, name)
                if os.path.isfile(child) and os.path.splitext(name)[1].lower() in AUDIO_COUNT:
                    bucket.append(child)
        except OSError:
            pass

totals = zero()
by_top = {}
skipped = []
candidates = []
for top, paths in sorted(files_by_top.items(), key=lambda kv: kv[0].lower()):
    counts = zero()
    for path in paths:
        count_ext(os.path.basename(path), counts)
    counts["total"] = counts["wav"] + counts["flac"] + counts["mp3"] + counts["aif"]
    by_top[top] = counts
    for k in totals:
        totals[k] += counts[k]
    sliceable = [
        p for p in paths
        if os.path.splitext(p)[1].lower() in AUDIO_SLICE and not PHRASE_RE.search(os.path.basename(p))
    ]
    top_path = os.path.join(base, top)
    top_l = top.lower()
    if not sliceable:
        skipped.append({"path": top_path, "reason": "no wav/flac/aif (or only phrase/slice names)", "files": counts["total"]})
        continue
    durs = probe(sliceable, 12)
    median = float(np.median(durs)) if durs else 0.0
    incoming_like = top_l == "incoming" or top_l.startswith("incoming")
    if incoming_like and sliced_incoming(sliceable, durs):
        skipped.append({"path": top_path, "reason": "incoming looks like already-sliced output", "files": len(sliceable)})
        continue
    if durs and median < 2.0:
        skipped.append({"path": top_path, "reason": "one-shots (median %.2fs)" % median, "files": len(sliceable)})
        continue
    preferred = top_l in PREFERRED or incoming_like or top_l.startswith("raw_") or top_l.startswith("landr")
    candidates.append({
        "path": top_path,
        "name": top,
        "files": len(sliceable),
        "median_sec": round(median, 2),
        "max_sec": round(max(durs), 2) if durs else 0.0,
        "preferred": bool(preferred),
    })

candidates.sort(key=lambda row: (not row["preferred"], -int(row["files"]), row["name"].lower()))

corpus = os.path.join(base, "corpus_4s")
corpus_n = 0
if os.path.isdir(corpus):
    for root, dirs, files in os.walk(corpus):
        dirs[:] = [d for d in dirs if d.lower() != "uploaded_slices"]
        for name in files:
            if name.lower().endswith(".wav"):
                corpus_n += 1
                if corpus_n >= 500:
                    break
        if corpus_n >= 500:
            break

json.dump({
    "base": base,
    "by_top": by_top,
    "candidates": candidates,
    "skipped": skipped,
    "excluded_present": excluded_present,
    "corpus_4s_wavs": corpus_n,
    "totals": totals,
}, sys.stdout)
'@

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "INGEST UNZIPPED PACKS  ($BaseDir)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ("Mode     : {0}" -f $(if ($doWork) { "EXECUTE" } else { "DRY-RUN (default)" }))
Write-Host "Python   : $python"
Write-Host "CodeRoot : $CodeRoot"
Write-Host "Limit    : $(if ($Limit -gt 0) { $Limit } else { 'auto' })"

Write-Host "`nWORKSTATION COPIES:" -ForegroundColor Yellow
Copy-WorkstationBits

$slicer = Get-SlicerPath
$indexer = Get-IndexerPath
$corpusDir = Join-Path $BaseDir "corpus_4s"
$indexDb = Join-Path $BaseDir "db\corpus_index.sqlite"
$indexWorkers = Get-IndexWorkers -Requested $Workers

Write-Host "Slicer   : $slicer"
Write-Host "Indexer  : $indexer"
Write-Host "Index DB : $indexDb"
Write-Host "Workers  : $indexWorkers"

$discoverFile = Join-Path $env:TEMP "hybrid_ingest_discover.py"
Set-Content -LiteralPath $discoverFile -Value $discoverPy -Encoding UTF8
Write-Host "`nDISCOVER (excludes uploaded_slices, corpus_4s, archive, renders, logs, db, ...):" -ForegroundColor Yellow
$discoverJson = & $python $discoverFile $BaseDir
if ($LASTEXITCODE -ne 0) { throw "Discovery failed (exit $LASTEXITCODE)." }
$discover = $discoverJson | ConvertFrom-Json

$totals = $discover.totals
Write-Host ("  Audio (wav/flac/mp3/aif) after excludes : {0}" -f $totals.total)
Write-Host ("    wav={0}  flac={1}  mp3={2}  aif={3}" -f $totals.wav, $totals.flac, $totals.mp3, $totals.aif)
Write-Host ("  corpus_4s wavs (output bank, not sliced) : {0}" -f $discover.corpus_4s_wavs)
if ($discover.excluded_present) {
    Write-Host ("  Excluded top-level present : {0}" -f ($discover.excluded_present -join ", "))
}

Write-Host "`nTOP FOLDERS (after excludes):" -ForegroundColor Yellow
$topRows = @($discover.by_top.PSObject.Properties | Sort-Object { $_.Value.total } -Descending)
foreach ($row in $topRows) {
    $c = $row.Value
    Write-Host ("  {0,-32} total={1,7}  wav={2,7} flac={3,6} mp3={4,6} aif={5,5}" -f $row.Name, $c.total, $c.wav, $c.flac, $c.mp3, $c.aif)
}

Write-Host "`nSKIPPED (not raw packs):" -ForegroundColor Yellow
foreach ($skip in @($discover.skipped)) {
    Write-Host ("  {0}  files={1}  ({2})" -f $skip.path, $skip.files, $skip.reason)
}

$candidates = @($discover.candidates)
Write-Host "`nRAW CANDIDATES:" -ForegroundColor Yellow
if ($candidates.Count -eq 0) {
    Write-Host "  (none)"
} else {
    foreach ($cand in $candidates) {
        $mark = $(if ($cand.preferred) { "*" } else { " " })
        Write-Host ("  {0} {1}  files={2}  median={3}s  max={4}s" -f $mark, $cand.path, $cand.files, $cand.median_sec, $cand.max_sec)
    }
}

$rawTotal = 0
foreach ($cand in $candidates) { $rawTotal += [int]$cand.files }

$sliceLimit = 0
$limitWasPassed = $PSBoundParameters.ContainsKey("Limit")
if ($limitWasPassed) {
    $sliceLimit = $Limit
} elseif ($rawTotal -gt 500) {
    $sliceLimit = 50
}

$sliceTargets = @()
$remaining = @()
if ($candidates.Count -gt 0) {
    if ($rawTotal -gt 500 -and $Limit -le 0) {
        $first = $candidates[0]
        $sliceTargets += @{ Path = [string]$first.path; Limit = $sliceLimit }
        $remaining += @{ Path = [string]$first.path; Note = "same folder after first $sliceLimit files" }
        for ($i = 1; $i -lt $candidates.Count; $i++) {
            $remaining += @{ Path = [string]$candidates[$i].path; Note = "not started" }
        }
    } else {
        $left = $sliceLimit
        foreach ($cand in $candidates) {
            if ($sliceLimit -le 0) {
                $sliceTargets += @{ Path = [string]$cand.path; Limit = 0 }
            } elseif ($left -le 0) {
                $remaining += @{ Path = [string]$cand.path; Note = "limit exhausted this run" }
            } else {
                $n = [int]$cand.files
                $use = [Math]::Min($n, $left)
                $sliceTargets += @{ Path = [string]$cand.path; Limit = $use }
                $left -= $use
                if ($n -gt $use) {
                    $remaining += @{ Path = [string]$cand.path; Note = "remaining $($n - $use) files" }
                }
            }
        }
    }
}

Write-Host "`nSLICE PLAN:" -ForegroundColor Yellow
Write-Host ("  Raw sliceable files : {0}" -f $rawTotal)
Write-Host ("  This-run cap        : {0}" -f $(if ($sliceLimit -le 0) { "all ($rawTotal)" } else { $sliceLimit }))
if ($sliceTargets.Count -eq 0) {
    Write-Host "  Nothing to slice."
} else {
    foreach ($t in $sliceTargets) {
        $cap = $(if ([int]$t.Limit -le 0) { "all" } else { [string]$t.Limit })
        Write-Host ("  --input {0}  --limit {1}" -f $t.Path, $cap)
    }
}

$slicerIsEngine = $slicer -like "*engine\smart_transient_slicer.py"
$remainderCommands = New-Object System.Collections.Generic.List[string]
foreach ($rem in $remaining) {
    $cmd = "& `"$python`" `"$slicer`" --input `"$($rem.Path)`" --output `"$corpusDir`" --workers $indexWorkers"
    $remainderCommands.Add($cmd)
}
if ($rawTotal -gt 500) {
    $remainderCommands.Add("# Continue ingest after reviewing the first batch:")
    $remainderCommands.Add("powershell -NoProfile -ExecutionPolicy Bypass -File `"$WorkstationScripts\ingest_all_unzipped.ps1`" -Execute -Limit 0")
}

$dbDir = Split-Path $indexDb -Parent
if (-not (Test-Path $dbDir)) { New-Item -ItemType Directory -Path $dbDir -Force | Out-Null }
$existingIndex = Get-SqliteCount -DbPath $indexDb
Write-Host "`nINDEX PLAN:" -ForegroundColor Yellow
Write-Host ("  slice_index COUNT(*) now : {0}" -f $existingIndex)
Write-Host ("  corpus_4s wavs           : {0}" -f $discover.corpus_4s_wavs)

$runIndexLimit = $IndexLimit
if ($runIndexLimit -le 0) { $runIndexLimit = 200 }
$bgIndexLimit = 0
if ([int]$discover.corpus_4s_wavs -gt 200) { $bgIndexLimit = 2000 }
if ([int]$discover.corpus_4s_wavs -ge 50000) {
    Write-Host "  corpus_4s is large (>=50k). Smoke --limit $runIndexLimit this run; background --limit 2000 (not --full)." -ForegroundColor Yellow
}

Write-Host ("  this-run indexer         : --limit {0} --workers {1}" -f $runIndexLimit, $indexWorkers)
if ($bgIndexLimit -gt 0) {
    Write-Host ("  background follow-up     : --limit {0} --workers {1}" -f $bgIndexLimit, $indexWorkers)
}

if (-not $doWork) {
    Write-Host "`nDRY-RUN complete. Re-run with -Execute to slice/index." -ForegroundColor Green
    Write-Host "`nExact Execute (raw packs only, never D:\ root, 8 workers):" -ForegroundColor Cyan
    Write-Host ('  powershell -NoProfile -File "{0}" -Execute -Workers 8' -f $PSCommandPath)
    Write-Host ('  "{0}" "{1}" --input "{2}" --output "{3}" --workers 8 --dry-run --limit 8' -f $python, $slicer, (Join-Path $BaseDir "raw_packs"), $corpusDir)
    if ($remainderCommands.Count -gt 0) {
        Write-Host "`nREMAINDER COMMANDS:" -ForegroundColor Cyan
        foreach ($line in $remainderCommands) { Write-Host "  $line" }
    }
    exit 0
}

if (-not (Test-Path $corpusDir)) { New-Item -ItemType Directory -Path $corpusDir -Force | Out-Null }

Write-Host "`nSLICE:" -ForegroundColor Yellow
if ($sliceTargets.Count -eq 0) {
    Write-Host "  No raw-pack folders to slice (one-shots / already-sliced / excluded)."
} else {
    foreach ($t in $sliceTargets) {
        if ($slicerIsEngine) {
            $argList = @($slicer, "--input", [string]$t.Path, "--output", $corpusDir, "--workers", [string]$indexWorkers)
        } else {
            $argList = @($slicer, "--raw", [string]$t.Path, "--corpus", $corpusDir)
        }
        if ([int]$t.Limit -gt 0) { $argList += @("--limit", [string]$t.Limit) }
        Write-Host ("  > {0} {1}" -f $python, ($argList -join " "))
        & $python @argList
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [WARN] slicer exit $LASTEXITCODE for $($t.Path)" -ForegroundColor Yellow
        }
    }
}

Write-Host "`nINDEX (numpy/scipy, HYBRID_USE_LIBROSA=0):" -ForegroundColor Yellow
$indexArgs = @(
    $indexer,
    "--corpus", $corpusDir,
    "--db", $indexDb,
    "--workers", [string]$indexWorkers,
    "--limit", [string]$runIndexLimit
)
Write-Host ("  > {0} {1}" -f $python, ($indexArgs -join " "))
& $python @indexArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [WARN] indexer exit $LASTEXITCODE" -ForegroundColor Yellow
}

if ($bgIndexLimit -gt $runIndexLimit) {
    $logDir = Join-Path $BaseDir "logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $bgOut = Join-Path $logDir "index_batch_$stamp.out.log"
    $bgErr = Join-Path $logDir "index_batch_$stamp.err.log"
    $bgIndexer = Join-Path $Workstation "db\index_578gb_corpus.py"
    if (-not (Test-Path $bgIndexer)) { $bgIndexer = $indexer }
    $bgWorkDir = Split-Path $bgIndexer -Parent | Split-Path -Parent
    $launcher = Join-Path $logDir "index_batch_$stamp.cmd"
    $launch = @"
@echo off
set PYTHONPATH=$bgWorkDir
set HYBRID_USE_LIBROSA=0
"$python" -u "$bgIndexer" --corpus "$corpusDir" --db "$indexDb" --workers $indexWorkers --limit $bgIndexLimit > "$bgOut" 2> "$bgErr"
"@
    Set-Content -LiteralPath $launcher -Value $launch -Encoding ASCII
    Write-Host ("  background : {0} --limit {1} (log {2})" -f $bgIndexer, $bgIndexLimit, $bgOut)
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$launcher`"" -WorkingDirectory $bgWorkDir -WindowStyle Hidden | Out-Null
    $remainderCommands.Add("# Background indexer logs: $bgOut / $bgErr")
}

$finalCount = Get-SqliteCount -DbPath $indexDb
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host ("SQLite COUNT(*)  {0}  ({1})" -f $finalCount, $indexDb) -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan

if ($remainderCommands.Count -gt 0) {
    Write-Host "`nREMAINDER COMMANDS (run these for the rest):" -ForegroundColor Cyan
    foreach ($line in $remainderCommands) { Write-Host "  $line" }
}

exit 0
