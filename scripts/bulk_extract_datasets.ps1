<#
.SYNOPSIS
    Bulk-extracts every dataset archive under D:\MusicDatasets.
.DESCRIPTION
    Uses the bsdtar/libarchive build shipped with Windows (tar.exe), which reads
    zip, tar, tar.gz, tgz, and zstd - so no 7-Zip install is required.

    Several archives in this corpus came from downloads that failed and were
    resumed repeatedly, so integrity is tested with `tar -tf` before extraction.
    A truncated archive is reported and skipped rather than half-unpacked.

    Extraction is idempotent: each archive writes a .extracted marker beside its
    destination folder recording the source size, and is skipped on later runs
    unless -Force is passed.

    Nested archives (a .zip inside an extracted .tar) are handled by running
    multiple passes until no new archives appear.
.PARAMETER VerifyOnly
    Test every archive and report corruption without extracting anything.
    Run this first - it is fast relative to extraction.
.PARAMETER DryRun
    Report the plan without testing or extracting.
.PARAMETER MinFreeGB
    Abort before starting an extraction that would drop free space below this.
.PARAMETER MaxPasses
    How many times to rescan for archives revealed by earlier extractions.
.PARAMETER Filter
    Wildcard against the archive's relative path, e.g. "mtg\*" or "*.zip".
.PARAMETER Force
    Re-extract archives that already have a .extracted marker.
.EXAMPLE
    .\bulk_extract_datasets.ps1 -VerifyOnly
    .\bulk_extract_datasets.ps1 -Filter "bass_db\*"
    .\bulk_extract_datasets.ps1
#>

param(
    [string]$BaseDir = "D:\MusicDatasets",
    [switch]$VerifyOnly = $false,
    [switch]$DryRun = $false,
    [int]$MinFreeGB = 200,
    [int]$MaxPasses = 3,
    [string]$Filter = "*",
    [switch]$Force = $false
)

$ErrorActionPreference = "Continue"

# Pipeline working directories - never treat their contents as source archives
$ExcludedSegments = @(
    "\incoming\",
    "\uploaded_slices\",
    "\renders\",
    "\archive\",
    "\spliced_staging\",
    "\completed_raw\",
    "\logs\",
    "\scripts\",
    "\config\",
    "\monitoring\"
)

# Longest suffix first so .tar.gz wins over .gz
$ArchiveSuffixes = @(
    ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst",
    ".tgz", ".tbz2", ".txz",
    ".tar", ".zip", ".7z", ".gz", ".bz2", ".xz", ".zst"
)

$tarExe = (Get-Command tar -ErrorAction SilentlyContinue).Source
if (-not $tarExe) {
    Write-Host "[ERROR] tar.exe not found. Windows 10 1803+ ships it at C:\Windows\System32\tar.exe." -ForegroundColor Red
    exit 1
}

function Get-ArchiveBaseName {
    param([string]$FileName)

    $lower = $FileName.ToLower()
    foreach ($suffix in $ArchiveSuffixes) {
        if ($lower.EndsWith($suffix)) {
            return $FileName.Substring(0, $FileName.Length - $suffix.Length)
        }
    }
    return [System.IO.Path]::GetFileNameWithoutExtension($FileName)
}

function Test-IsArchive {
    param([string]$FileName)

    $lower = $FileName.ToLower()
    foreach ($suffix in $ArchiveSuffixes) {
        if ($lower.EndsWith($suffix)) { return $true }
    }
    return $false
}

function Get-CandidateArchives {
    Get-ChildItem -Path $BaseDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            (Test-IsArchive -FileName $_.Name) -and
            -not ($ExcludedSegments | Where-Object { $_ -and $_.FullName -like "*$_*" })
        } |
        Where-Object {
            $rel = $_.FullName.Replace("$BaseDir\", "")
            $rel -like $Filter
        } |
        Sort-Object Length
}

function Get-FreeGB {
    [math]::Round((Get-PSDrive -Name ($BaseDir.Substring(0,1))).Free / 1GB, 2)
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - BULK DATASET EXTRACTION" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "Base Directory : $BaseDir"
Write-Host "Extractor      : $tarExe"
Write-Host "Filter         : $Filter"
Write-Host "Free Space     : $(Get-FreeGB) GB (floor: $MinFreeGB GB)"
Write-Host "Mode           : $(if ($DryRun) { '[DRY RUN]' } elseif ($VerifyOnly) { '[VERIFY ONLY]' } else { '[EXTRACT]' })"
Write-Host "================================================================" -ForegroundColor Cyan

$extracted = @()
$skipped = @()
$corrupt = @()
$failed = @()
$totalBytesIn = 0

for ($pass = 1; $pass -le $MaxPasses; $pass++) {

    $archives = @(Get-CandidateArchives)

    # Drop anything already handled in an earlier pass of this run
    $handled = @($extracted + $skipped + $corrupt + $failed)
    $archives = @($archives | Where-Object { $handled -notcontains $_.FullName })

    if ($archives.Count -eq 0) {
        if ($pass -eq 1) { Write-Host "`n[INFO] No archives matched." -ForegroundColor Yellow }
        break
    }

    Write-Host "`n--- PASS $pass : $($archives.Count) archive(s) ---" -ForegroundColor Yellow

    foreach ($archive in $archives) {
        $rel = $archive.FullName.Replace("$BaseDir\", "")
        $sizeGb = [math]::Round($archive.Length / 1GB, 2)
        $baseName = Get-ArchiveBaseName -FileName $archive.Name
        $destDir = Join-Path $archive.DirectoryName $baseName
        $marker = "$destDir.extracted"

        # Already done?
        if ((Test-Path $marker) -and -not $Force) {
            Write-Host "  [SKIP]    $rel ($sizeGb GB) - marker present" -ForegroundColor DarkGray
            $skipped += $archive.FullName
            continue
        }

        if ($DryRun) {
            Write-Host "  [PLAN]    $rel ($sizeGb GB) -> $baseName\" -ForegroundColor Gray
            $skipped += $archive.FullName
            continue
        }

        # Integrity test. Truncated downloads are common in this corpus.
        Write-Host "  [TEST]    $rel ($sizeGb GB)..." -ForegroundColor Gray -NoNewline
        $testOutput = & $tarExe -tf $archive.FullName 2>&1
        $testExit = $LASTEXITCODE

        if ($testExit -ne 0) {
            $firstError = ($testOutput | Select-Object -First 1)
            Write-Host "`r  [CORRUPT] $rel ($sizeGb GB) - $firstError" -ForegroundColor Red
            $corrupt += $archive.FullName
            continue
        }

        $entryCount = ($testOutput | Measure-Object).Count
        Write-Host "`r  [OK]      $rel ($sizeGb GB, $entryCount entries)          " -ForegroundColor Green

        if ($VerifyOnly) {
            $skipped += $archive.FullName
            continue
        }

        # Space guard: assume worst case that extracted size equals archive size
        $freeGb = Get-FreeGB
        if (($freeGb - $sizeGb) -lt $MinFreeGB) {
            Write-Host "  [ABORT]   Free space would fall below $MinFreeGB GB. Stopping." -ForegroundColor Red
            $failed += $archive.FullName
            break
        }

        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        }

        Write-Host "  [EXTRACT] $rel -> $baseName\ ..." -ForegroundColor Cyan
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        & $tarExe -xf $archive.FullName -C $destDir 2>&1 | Out-Null
        $extractExit = $LASTEXITCODE
        $sw.Stop()

        if ($extractExit -ne 0) {
            Write-Host "            FAILED (exit $extractExit after $([math]::Round($sw.Elapsed.TotalMinutes,1)) min)" -ForegroundColor Red
            $failed += $archive.FullName
            continue
        }

        @(
            "source=$($archive.FullName)"
            "source_bytes=$($archive.Length)"
            "extracted_utc=$((Get-Date).ToUniversalTime().ToString('o'))"
            "entries=$entryCount"
            "duration_sec=$([math]::Round($sw.Elapsed.TotalSeconds,1))"
        ) | Set-Content -Path $marker -Encoding UTF8

        $mins = [math]::Round($sw.Elapsed.TotalMinutes, 1)
        Write-Host "            done in $mins min | free now: $(Get-FreeGB) GB" -ForegroundColor Green

        $extracted += $archive.FullName
        $totalBytesIn += $archive.Length
    }

    if ($VerifyOnly -or $DryRun) { break }
}

# -------------------------------------------------------------------------
# SUMMARY
# -------------------------------------------------------------------------
Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "EXTRACTION SUMMARY" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Extracted : $($extracted.Count) archive(s), $([math]::Round($totalBytesIn/1GB,2)) GB read"
Write-Host "  Skipped   : $($skipped.Count)"
Write-Host "  Corrupt   : $($corrupt.Count)" -ForegroundColor $(if ($corrupt.Count -gt 0) { "Red" } else { "Gray" })
Write-Host "  Failed    : $($failed.Count)" -ForegroundColor $(if ($failed.Count -gt 0) { "Red" } else { "Gray" })
Write-Host "  Free Space: $(Get-FreeGB) GB"

if ($corrupt.Count -gt 0) {
    Write-Host "`nCORRUPT ARCHIVES - these need re-downloading:" -ForegroundColor Red
    $corrupt | ForEach-Object { Write-Host "  $($_.Replace("$BaseDir\",''))" -ForegroundColor Red }
}

if ($failed.Count -gt 0) {
    Write-Host "`nFAILED EXTRACTIONS:" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  $($_.Replace("$BaseDir\",''))" -ForegroundColor Red }
}

Write-Host "================================================================" -ForegroundColor Cyan
