<#
.SYNOPSIS
    Safe zip intake: incoming_zips -> raw_packs -> slice corpus_4s -> smoke-index.
.DESCRIPTION
    This is NOT a recursive D:\ sweep and it does not delete zips by default.

    Default is -DryRun. Live extract requires -Execute. Remove-Item on a zip
    requires BOTH -Execute and -Purge. DryRun never extracts and never deletes.

    Default scan is D:\MusicDatasets\incoming_zips (non-recursive). Scanning
    D:\ or D:\music data (depth 0 only) requires -IncludeDriveRoot. This script
    never walks D:\ recursively and never uses D:\ or D:\MusicDatasets as
    slicer --input.

    Hard excludes (always): fma_full.zip, name -match 'fma', size >= 2GB,
    anything under corpus_4s, uploaded_slices, scratch, releases, archive,
    .git, node_modules.

    Extract target: D:\MusicDatasets\raw_packs\<clean_name>\.
    Keep the zip if extract count is 0 or an exception is thrown.

    Slicer: engine\smart_transient_slicer.py --input raw_packs --output corpus_4s.
    Indexer: db\index_578gb_corpus.py (numpy/scipy chroma/BPM — not CQT/librosa
    unless HYBRID_USE_LIBROSA=1). --full requires -FullIndex. Without -FullIndex
    the indexer always gets --limit (default 8).

    Pack ledger: db\pack_tracker.py pack_manifest (pack_name PK, zip_filename,
    status PENDING/UNZIPPED/SLICED/READY_TO_GO/FAILED, raw_path, slice_count,
    updated_at). DryRun does not write the ledger.

    Python is Get-HybridPython (never Store stub / D:\MusicDatasets\venv).
    Does not replace run_master_pipeline.ps1.
.PARAMETER DryRun
    List candidate/excluded zips, slicer --dry-run, print indexer command.
    This is the default. Never extract, never Remove-Item, never --full.
.PARAMETER Execute
    Extract eligible zips into raw_packs, then slice and index.
.PARAMETER Purge
    After a successful extract+verify, delete the zip. Ignored unless -Execute.
    DryRun never deletes.
.PARAMETER IncludeDriveRoot
    Also scan D:\ and D:\music data at depth 0 (files only, no recurse).
    Default scan is incoming_zips only.
.PARAMETER FullIndex
    Pass --full to the indexer (overnight). Do not use casually. DryRun prints
    the command and does not run it.
.PARAMETER Workers
    Slicer and indexer pool size. Default 8.
.PARAMETER Limit
    Cap slicer source files and indexer wavs. Default 8. Indexer without
    -FullIndex always gets --limit (never an uncapped walk).
.PARAMETER BaseDir
    Dataset root. Default D:\MusicDatasets.
.EXAMPLE
    .\auto_unzip_purge_and_index.ps1
    .\auto_unzip_purge_and_index.ps1 -Execute -Workers 8 -Limit 8
    .\auto_unzip_purge_and_index.ps1 -Execute -Purge -Workers 8 -Limit 8
#>

param(
    [switch]$DryRun,
    [switch]$Execute,
    [switch]$Purge,
    [switch]$IncludeDriveRoot,
    [switch]$FullIndex,
    [int]$Workers = 8,
    [int]$Limit = 8,
    [string]$BaseDir = "D:\MusicDatasets"
)

$ErrorActionPreference = "Stop"
$doWork = [bool]$Execute
if (-not $Execute -and -not $DryRun) { $DryRun = $true }

if ($Workers -le 0) { $Workers = 8 }
$indexLimit = if ($Limit -gt 0) { $Limit } else { 8 }
$MaxZipBytes = 2GB
$ExcludeDirNames = @(
    "corpus_4s",
    "uploaded_slices",
    "scratch",
    "releases",
    "archive",
    ".git",
    "node_modules"
)

$Incoming = Join-Path $BaseDir "incoming_zips"
$RawPacks = Join-Path $BaseDir "raw_packs"
$SliceOut = Join-Path $BaseDir "corpus_4s"
$DbPath = Join-Path $BaseDir "db\corpus_index.sqlite"

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
        @{ Src = Join-Path $ScriptsDir "auto_unzip_purge_and_index.ps1"; Dst = Join-Path $WorkstationScripts "auto_unzip_purge_and_index.ps1" },
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

function Test-ForbiddenSlicerInput {
    param([string]$Path)
    if (-not $Path) { return $true }
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $forbidden = @(
        "D:",
        "D:\",
        $BaseDir.TrimEnd('\')
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

function Get-CleanPackName {
    param([string]$ZipFileName)
    $base = [System.IO.Path]::GetFileNameWithoutExtension($ZipFileName)
    $clean = ($base -replace '[\s\-]+', '_').Trim('_')
    if (-not $clean) { return "unnamed_pack" }
    return $clean
}

function Test-UnderExcludedDir {
    param([string]$Path)
    if (-not $Path) { return $true }
    $parts = $Path.Split([char[]]@('\', '/')) | Where-Object { $_ }
    foreach ($part in $parts) {
        foreach ($blocked in $ExcludeDirNames) {
            if ($part -ieq $blocked) { return $true }
        }
    }
    return $false
}

function Get-ZipExcludeReason {
    param(
        [System.IO.FileInfo]$File,
        [string]$ScanRoot
    )
    if (-not $File) { return "missing file" }
    $name = $File.Name
    if ($name -ieq "fma_full.zip") { return "fma_full.zip (dataset archive)" }
    if ($name -match 'fma') { return "name matches 'fma'" }
    if ($File.Length -ge $MaxZipBytes) {
        return ("size {0:N2} GB >= 2GB" -f ($File.Length / 1GB))
    }
    if (Test-UnderExcludedDir -Path $File.FullName) {
        return "path under excluded directory"
    }
    if (Test-UnderExcludedDir -Path $ScanRoot) {
        return "scan root is an excluded directory"
    }
    return $null
}

function Get-ScanRoots {
    $roots = @()
    $roots += [pscustomobject]@{ Path = $Incoming; Label = "incoming_zips"; Depth0 = $true }
    if ($IncludeDriveRoot) {
        $roots += [pscustomobject]@{ Path = "D:\"; Label = "D:\\ (depth 0)"; Depth0 = $true }
        $musicData = "D:\music data"
        if (Test-Path -LiteralPath $musicData) {
            $roots += [pscustomobject]@{ Path = $musicData; Label = "D:\\music data (depth 0)"; Depth0 = $true }
        } else {
            Write-Host "  [SKIP] D:\music data does not exist (Seagate label; MusicDatasets is D:\MusicDatasets)."
        }
    } else {
        Write-Host "  [SAFE] Not scanning D:\ or D:\music data (pass -IncludeDriveRoot for depth-0 listing only)."
    }
    return $roots
}

function Get-ZipsInRoot {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    # Depth 0 only: files in this folder, never -Recurse (protects fma_full.zip trees).
    return @(Get-ChildItem -LiteralPath $Root -File -Filter "*.zip" -ErrorAction SilentlyContinue |
        Sort-Object Name)
}

function Get-ExtractedFileCount {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return @(Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue).Count
}

function Invoke-SafeExtract {
    param(
        [string]$ZipPath,
        [string]$DestDir
    )
    $code = @"
import sys
from db.pack_tracker import extract_zip_to, assert_safe_raw_packs
zip_path, dest, workstation = sys.argv[1], sys.argv[2], sys.argv[3]
assert_safe_raw_packs(dest, workstation=workstation)
print(extract_zip_to(zip_path, dest))
"@
    $out = & $python -c $code $ZipPath $DestDir $BaseDir
    if ($LASTEXITCODE -ne 0) {
        throw "extract_zip_to failed for $ZipPath (exit $LASTEXITCODE)"
    }
    $text = ("$out").Trim()
    $last = ($text -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    return [int]$last
}

function Set-PackLedger {
    param(
        [string]$PackName,
        [string]$ZipFileName,
        [string]$Status,
        [string]$RawPath,
        [int]$SliceCount = 0
    )
    $allowed = @("PENDING", "UNZIPPED", "SLICED", "READY_TO_GO", "FAILED")
    if ($allowed -notcontains $Status) {
        throw "Refusing pack_manifest status '$Status' (schema is $($allowed -join '/'))."
    }
    $code = @"
import sys
from db.pack_tracker import connect_corpus_db, upsert_pack
pack_name, zip_filename, status, raw_path, slice_count, db_path = sys.argv[1:7]
conn = connect_corpus_db(db_path)
try:
    upsert_pack(conn, pack_name, zip_filename, status, raw_path, slice_count=int(slice_count))
    print('[LEDGER] {0} {1}'.format(status, pack_name))
finally:
    conn.close()
"@
    & $python -c $code $PackName $ZipFileName $Status $RawPath ([string]$SliceCount) $DbPath
}

function Format-SizeGB {
    param([long]$Bytes)
    return ("{0:N2} GB" -f ($Bytes / 1GB))
}

# incoming_zips / raw_packs only — never mkdir D:\ or D:\music data
foreach ($dir in @($Incoming, $RawPacks)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "  [CREATE] $dir" -ForegroundColor Green
    }
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "SAFE UNZIP / PURGE / INDEX  ($BaseDir)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ("Mode          : {0}" -f $(if ($doWork) { "EXECUTE" } else { "DRY-RUN (default)" }))
Write-Host ("Purge zips    : {0}" -f $(if ($doWork -and $Purge) { "YES (Execute+Purge)" } else { "NO (DryRun never deletes; need -Execute -Purge)" }))
Write-Host ("Drive root    : {0}" -f $(if ($IncludeDriveRoot) { "depth-0 D:\\ and D:\\music data" } else { "OFF (incoming_zips only)" }))
Write-Host ("FullIndex     : {0}" -f $(if ($FullIndex) { "YES (indexer --full; not used on DryRun)" } else { "NO (indexer --limit $indexLimit)" }))
Write-Host "Python        : $python"
Write-Host "CodeRoot      : $CodeRoot"
Write-Host "Incoming      : $Incoming"
Write-Host "RawPacks      : $RawPacks"
Write-Host "SliceOut      : $SliceOut"
Write-Host "Index DB      : $DbPath"
Write-Host "Workers       : $Workers"
Write-Host ("Limit         : {0}" -f $(if ($Limit -gt 0) { $Limit } else { "slicer uncapped; indexer still --limit $indexLimit unless -FullIndex" }))
Write-Host "Indexer note  : numpy/scipy (dsp.pitch_key_aligner / dsp.tempo_time_stretch). Not CQT/librosa unless HYBRID_USE_LIBROSA=1."
Write-Host "Hard excludes : fma_full.zip, name~fma, size>=2GB, corpus_4s/uploaded_slices/scratch/releases/archive/.git/node_modules"

if ($Purge -and -not $doWork) {
    Write-Host "  [SAFE] -Purge ignored on DryRun. No Remove-Item." -ForegroundColor Yellow
}

if ($doWork) {
    Write-Host "`nWORKSTATION COPIES:" -ForegroundColor Yellow
    Copy-WorkstationBits
} else {
    Write-Host "`nWORKSTATION COPIES: skipped on DryRun (deploy/copy is a separate step)." -ForegroundColor Yellow
}

$slicer = Get-SlicerPath
$indexer = Get-IndexerPath
Write-Host "Slicer        : $slicer"
Write-Host "Indexer       : $indexer"
Write-Host "Ledger        : db\pack_tracker.py (pack_manifest schema unchanged)"

$seen = 0
$eligible = 0
$excluded = 0
$extracted = 0
$kept = 0
$purged = 0
$failed = 0
$unzipOk = $true
$sliceOk = $false
$indexOk = $false

Write-Host "`nSTEP 1  SCAN / EXTRACT:" -ForegroundColor Yellow
Write-Host "  Default source is incoming_zips. This is not a D:\ recursive zip harvest."
$scanRoots = Get-ScanRoots
$eligibleZips = @()

foreach ($root in $scanRoots) {
    $rootPath = $root.Path
    if (-not (Test-Path -LiteralPath $rootPath)) {
        Write-Host ("  [MISS] {0} ({1})" -f $root.Label, $rootPath)
        continue
    }
    $zips = Get-ZipsInRoot -Root $rootPath
    Write-Host ("  [SCAN] {0}: {1} zip(s) at depth 0" -f $root.Label, $zips.Count)
    foreach ($zip in $zips) {
        $seen++
        $reason = Get-ZipExcludeReason -File $zip -ScanRoot $rootPath
        if ($reason) {
            $excluded++
            Write-Host ("    [EXCLUDE] {0}  {1}  ({2})" -f $zip.Name, (Format-SizeGB $zip.Length), $reason) -ForegroundColor DarkYellow
            continue
        }
        $packName = Get-CleanPackName -ZipFileName $zip.Name
        $dest = Join-Path $RawPacks $packName
        if (Test-UnderExcludedDir -Path $dest) {
            $excluded++
            Write-Host ("    [EXCLUDE] {0} dest would be under an excluded directory" -f $zip.Name) -ForegroundColor DarkYellow
            continue
        }
        $eligible++
        $eligibleZips += [pscustomobject]@{
            File     = $zip
            PackName = $packName
            Dest     = $dest
            ScanRoot = $rootPath
        }
        Write-Host ("    [CANDIDATE] {0}  {1}  -> {2}" -f $zip.Name, (Format-SizeGB $zip.Length), $dest)
    }
}

Write-Host ("  Totals: seen={0} eligible={1} excluded={2}" -f $seen, $eligible, $excluded)

if (-not $doWork) {
    foreach ($item in $eligibleZips) {
        Write-Host ("  [DRY-RUN] would extract {0} -> {1} (zip kept; no Purge on DryRun)" -f $item.File.Name, $item.Dest)
        Write-Host ("  [DRY-RUN] would ledger PENDING/UNZIPPED pack_name={0} zip_filename={1}" -f $item.PackName, $item.File.Name)
    }
    if ($eligible -eq 0) {
        Write-Host "  [DRY-RUN] no eligible zips in scanned roots. Copy LANDR zips into incoming_zips."
    }
} else {
    foreach ($item in $eligibleZips) {
        $zip = $item.File
        $dest = $item.Dest
        $packName = $item.PackName
        Write-Host ("  [EXTRACT] {0} -> {1}" -f $zip.FullName, $dest)
        Set-PackLedger -PackName $packName -ZipFileName $zip.Name -Status "PENDING" -RawPath $dest | ForEach-Object { Write-Host "    $_" }
        $count = -1
        try {
            $count = Invoke-SafeExtract -ZipPath $zip.FullName -DestDir $dest
        } catch {
            $failed++
            $unzipOk = $false
            $kept++
            Write-Host ("    [KEEP] exception extracting {0}: {1}" -f $zip.Name, $_.Exception.Message) -ForegroundColor Yellow
            Set-PackLedger -PackName $packName -ZipFileName $zip.Name -Status "FAILED" -RawPath $dest | ForEach-Object { Write-Host "    $_" }
            continue
        }
        $onDisk = Get-ExtractedFileCount -Path $dest
        if ($count -le 0 -or $onDisk -le 0) {
            $kept++
            $unzipOk = $false
            Write-Host ("    [KEEP] extract count={0} on_disk={1}; zip not deleted" -f $count, $onDisk) -ForegroundColor Yellow
            Set-PackLedger -PackName $packName -ZipFileName $zip.Name -Status "FAILED" -RawPath $dest | ForEach-Object { Write-Host "    $_" }
            continue
        }
        $extracted++
        Set-PackLedger -PackName $packName -ZipFileName $zip.Name -Status "UNZIPPED" -RawPath $dest | ForEach-Object { Write-Host "    $_" }
        Write-Host ("    [OK] files={0} on_disk={1}" -f $count, $onDisk)
        if ($Purge) {
            try {
                Remove-Item -LiteralPath $zip.FullName -Force
                $purged++
                Write-Host ("    [PURGE] deleted {0}" -f $zip.FullName)
            } catch {
                $kept++
                $unzipOk = $false
                Write-Host ("    [KEEP] Purge failed for {0}: {1}" -f $zip.Name, $_.Exception.Message) -ForegroundColor Yellow
            }
        } else {
            $kept++
            Write-Host "    [KEEP] -Purge not set; zip left in place"
        }
    }
}

# --- Step 2: slicer (raw_packs only) ---
Write-Host "`nSTEP 2  SLICE:" -ForegroundColor Yellow
$sliceInput = $RawPacks
if (Test-ForbiddenSlicerInput -Path $sliceInput) {
    Write-Host "  [SKIP] refusing forbidden slicer --input $sliceInput (never D:\ or D:\MusicDatasets)." -ForegroundColor Yellow
} elseif (-not (Test-Path -LiteralPath $sliceInput)) {
    Write-Host "  [SKIP] raw_packs missing. Not falling back to D:\ or D:\MusicDatasets."
} elseif (-not (Test-DirHasAudio -Path $sliceInput)) {
    Write-Host "  [SKIP] raw_packs has no wav/flac/aif. Not falling back to D:\ or D:\MusicDatasets."
} else {
    $argList = @(
        $slicer,
        "--input", $sliceInput,
        "--output", $SliceOut,
        "--workers", [string]$Workers
    )
    if (-not $doWork) { $argList += "--dry-run" }
    if ($Limit -gt 0) { $argList += @("--limit", [string]$Limit) }
    Write-Host ("  > {0} {1}" -f $python, ($argList -join " "))
    $sliceOutText = & $python @argList 2>&1 | ForEach-Object { "$_" }
    $sliceOutText | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [WARN] slicer exit $LASTEXITCODE" -ForegroundColor Yellow
        $sliceOk = $false
    } else {
        $sliceOk = $true
    }
}

# --- Step 3: indexer (never --full unless -FullIndex; DryRun does not write) ---
Write-Host "`nSTEP 3  INDEX (numpy/scipy; no CQT unless HYBRID_USE_LIBROSA=1):" -ForegroundColor Yellow
Write-Host "  db\index_578gb_corpus.py uses numpy/scipy via dsp.pitch_key_aligner and dsp.tempo_time_stretch."
Write-Host "  It is not a librosa CQT indexer unless HYBRID_USE_LIBROSA=1 (this script sets that to 0)."
Write-Host "  corpus_4s already holds tens of thousands of wavs. --full is overnight; this session should not pass it."

$indexCmdFull = "{0} {1} --corpus {2} --db {3} --workers {4} --full" -f $python, $indexer, $SliceOut, $DbPath, $Workers
$indexCmdLimit = "{0} {1} --corpus {2} --db {3} --workers {4} --limit {5}" -f $python, $indexer, $SliceOut, $DbPath, $Workers, $indexLimit

if (-not $doWork) {
    Write-Host "  [DRY-RUN] no slice_index writes."
    if ($FullIndex) {
        Write-Host "  [DRY-RUN] -FullIndex set but DryRun will not run --full."
        Write-Host "  documented overnight (do not start casually): $indexCmdFull"
    } else {
        Write-Host "  documented smoke (not run): $indexCmdLimit"
    }
} elseif ($FullIndex) {
    Write-Host "  [WARN] -FullIndex: running overnight --full of corpus_4s." -ForegroundColor Yellow
    $indexArgs = @(
        $indexer,
        "--corpus", $SliceOut,
        "--db", $DbPath,
        "--workers", [string]$Workers,
        "--full"
    )
    Write-Host ("  > {0} {1}" -f $python, ($indexArgs -join " "))
    & $python @indexArgs
    if ($LASTEXITCODE -eq 0) { $indexOk = $true }
    else {
        Write-Host "  [WARN] indexer exit $LASTEXITCODE" -ForegroundColor Yellow
        $indexOk = $false
    }
} else {
    $indexArgs = @(
        $indexer,
        "--corpus", $SliceOut,
        "--db", $DbPath,
        "--workers", [string]$Workers,
        "--limit", [string]$indexLimit
    )
    Write-Host ("  > {0} {1}" -f $python, ($indexArgs -join " "))
    & $python @indexArgs
    if ($LASTEXITCODE -eq 0) {
        $indexOk = $true
        Write-Host ("  [INFO] smoke index --limit {0} succeeded; not marking READY_TO_GO (partial corpus)." -f $indexLimit)
    } else {
        Write-Host "  [WARN] indexer exit $LASTEXITCODE" -ForegroundColor Yellow
        $indexOk = $false
    }
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host ("Zip counts   : seen={0} eligible={1} excluded={2} extracted={3} kept={4} purged={5} failed={6}" -f $seen, $eligible, $excluded, $extracted, $kept, $purged, $failed)
if (-not $doWork) {
    Write-Host "DRY-RUN finished. No zips extracted. No zips deleted. Ledger not written." -ForegroundColor Green
    Write-Host ('  Live extract (keep zips): powershell -NoProfile -File "{0}" -Execute -Workers 8 -Limit 8' -f $PSCommandPath)
    Write-Host ('  Live extract + delete:   powershell -NoProfile -File "{0}" -Execute -Purge -Workers 8 -Limit 8' -f $PSCommandPath)
    Write-Host "  Drive-root depth-0 scan requires -IncludeDriveRoot (still excludes fma / >=2GB)."
} elseif ($unzipOk -and $sliceOk -and $indexOk -and $failed -eq 0) {
    Write-Host "Execute finished (slice/index steps reported ok). Not claiming all packs READY_TO_GO." -ForegroundColor Green
} else {
    Write-Host "Execute finished with skipped or failed steps. Not claiming pipeline complete." -ForegroundColor Yellow
}
Write-Host "================================================================" -ForegroundColor Cyan

if ($doWork -and ($failed -gt 0 -or -not $unzipOk)) { exit 1 }
exit 0
