<#
.SYNOPSIS
    Preview or (opt-in) produce: album helper + catalog sync + distro zip.
.DESCRIPTION
    Default -DryRun / -WhatIf prints the three steps and does not generate tracks.
    -Produce still passes -Limit through to batch_album_generator (default 0 = print only).
    Does not replace run_master_pipeline.ps1. Does not install NSSM.
#>
[CmdletBinding()]
param(
    [switch]$Produce,
    [switch]$DryRun,
    [switch]$WhatIf,
    [int]$Limit = 0,
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$AlbumDir = "D:\MusicDatasets\releases\heavy_sky_arrival",
    [string]$OutZip = "D:\MusicDatasets\releases\heavy_sky_arrival.zip"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ResolvePython = Join-Path $PSScriptRoot "resolve_python.ps1"
if (-not (Test-Path $ResolvePython)) {
    $ResolvePython = Join-Path $BaseDir "scripts\resolve_python.ps1"
}
. $ResolvePython
$python = Get-HybridPython
if (-not $python) { throw "Python interpreter not resolvable." }

$isPreview = (-not $Produce) -or $DryRun -or $WhatIf

function Resolve-Tool {
    param([string]$Rel)
    $d = Join-Path $BaseDir $Rel
    if (Test-Path $d) { return $d }
    $r = Join-Path $RepoRoot $Rel
    if (Test-Path $r) { return $r }
    return $d
}

$albumGen = Resolve-Tool "scripts\batch_album_generator.ps1"
$catalog = Resolve-Tool "db\catalog_syncer.py"
$distro = Resolve-Tool "engine\distro_bundle_packager.py"

Write-Host "[DEPLOY] preview=$isPreview  Limit=$Limit  python=$python"
Write-Host "[DEPLOY] step 1/3  batch_album_generator.ps1  (album=$AlbumDir)"
Write-Host "[DEPLOY] step 2/3  catalog_syncer.py          (SQLite only, no website)"
Write-Host "[DEPLOY] step 3/3  distro_bundle_packager.py  (zip=$OutZip)"

if ($isPreview) {
    Write-Host "[DRY-RUN] not generating 10 tracks; not writing zip; catalog --dry-run"
    & $albumGen -Limit $Limit -DryRun -BaseDir $BaseDir -AlbumDir $AlbumDir
    & $python $catalog --releases (Join-Path $BaseDir "releases") --db (Join-Path $BaseDir "db\catalog.sqlite") --dry-run
    & $python $distro --album $AlbumDir --out-zip $OutZip --dry-run
    Write-Host "[DEPLOY] dry-run complete. Pass -Produce -Limit N to opt in (still limited)."
    exit 0
}

& $albumGen -Limit $Limit -Produce -BaseDir $BaseDir -AlbumDir $AlbumDir
& $python $catalog --releases (Join-Path $BaseDir "releases") --db (Join-Path $BaseDir "db\catalog.sqlite")
& $python $distro --album $AlbumDir --out-zip $OutZip
exit $LASTEXITCODE
