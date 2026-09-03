<#
.SYNOPSIS
    Heavy Sky Arrival album helper. Default -Limit 0 is print-only (no produce).
.DESCRIPTION
    Does not generate 10 tracks unless -Limit N (N>0) and -Produce are both set.
    QC uses dsp/qc_metric_validator.py on an existing wav only.
    Copy-to-album happens only when the file exists. QC fail is never reported as PASS.
#>
[CmdletBinding()]
param(
    [int]$Limit = 0,
    [switch]$Produce,
    [switch]$DryRun,
    [switch]$WhatIf,
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$AlbumDir = "D:\MusicDatasets\releases\heavy_sky_arrival"
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

$isPreview = ($Limit -le 0) -or $DryRun -or $WhatIf -or (-not $Produce)

$tracks = @(
    @{ Id = "album_hsa_01"; Title = "Heavy Sky Arrival" },
    @{ Id = "album_hsa_02"; Title = "Runway Lights" },
    @{ Id = "album_hsa_03"; Title = "Glass Horizon" },
    @{ Id = "album_hsa_04"; Title = "Night Circuit" },
    @{ Id = "album_hsa_05"; Title = "Static Bloom" },
    @{ Id = "album_hsa_06"; Title = "Afterburner" },
    @{ Id = "album_hsa_07"; Title = "Low Ceiling" },
    @{ Id = "album_hsa_08"; Title = "Ion Trail" },
    @{ Id = "album_hsa_09"; Title = "Last Approach" },
    @{ Id = "album_hsa_10"; Title = "Touchdown" }
)

Write-Host "[ALBUM] Heavy Sky Arrival  tracks=$($tracks.Count)  Limit=$Limit  preview=$isPreview"
Write-Host "[ALBUM] albumDir=$AlbumDir"

$qcScript = Join-Path $BaseDir "dsp\qc_metric_validator.py"
if (-not (Test-Path $qcScript)) {
    $qcScript = Join-Path $RepoRoot "dsp\qc_metric_validator.py"
}

function Resolve-MasterWav {
    param([string]$Session)
    $paths = @(
        (Join-Path $BaseDir "renders\$Session\master_output.wav"),
        (Join-Path $BaseDir "scratch\$Session\${Session}_master.wav"),
        (Join-Path $BaseDir "scratch\$Session\unmastered_mix.wav"),
        (Join-Path $BaseDir "scratch\$Session\${Session}_unmastered.wav")
    )
    foreach ($p in $paths) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

$take = $tracks
if ($Limit -gt 0) { $take = $tracks | Select-Object -First $Limit }

foreach ($track in $take) {
    $session = $track.Id
    $wav = Resolve-MasterWav -Session $session
    Write-Host ("  [{0}] {1}" -f $session, $track.Title)
    if (-not $wav) {
        Write-Host '        no wav at renders\master_output.wav or scratch unmastered/master - skip'
        continue
    }
    Write-Host "        wav=$wav"
    if ($isPreview) {
        Write-Host '        WOULD QC + copy - preview, not producing'
        continue
    }
    $qcOk = $false
    if (Test-Path $qcScript) {
        & $python $qcScript --input $wav
        $qcOk = ($LASTEXITCODE -eq 0)
    } else {
        Write-Host '        [WARN] qc_metric_validator.py missing'
    }
    if (-not $qcOk) {
        Write-Host '        QC FAIL - not copying, not claiming PASS'
        continue
    }
    if (-not (Test-Path $AlbumDir)) {
        New-Item -ItemType Directory -Path $AlbumDir | Out-Null
    }
    $dest = Join-Path $AlbumDir ("{0}_{1}.wav" -f $session, ($track.Title -replace '[^\w\- ]', ''))
    Copy-Item -LiteralPath $wav -Destination $dest -Force
    Write-Host "        QC PASS copied $dest"
}

if ($isPreview) {
    Write-Host '[ALBUM] dry-run / Limit=0 - no tracks generated. Use -Produce -Limit N for a short run.'
}
exit 0
