<#
.SYNOPSIS
    Safe scratch janitor. Default is dry-run; never touches releases or scratch\uploads.
.DESCRIPTION
    Only session-like folders older than -MaxAgeHours are candidates:
    session_*, trk_*, diag_*, dynamic_*, prompt_*, release_*, headless_*

    Default is -WhatIf / -DryRun (print WOULD DELETE). Pass -Execute to delete.
    Does not run deletions unless -Execute is set. Never deletes releases\.
.PARAMETER Execute
    Actually delete matching folders. Required for any removal.
.PARAMETER DryRun
    Force preview (default).
.PARAMETER WhatIf
    Same as -DryRun.
.PARAMETER MaxAgeHours
    Age threshold (default 24).
.PARAMETER Scratch
    Scratch root (default D:\MusicDatasets\scratch).
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$DryRun,
    [switch]$WhatIf,
    [int]$MaxAgeHours = 24,
    [string]$Scratch = "D:\MusicDatasets\scratch"
)

$ErrorActionPreference = "Stop"
$patterns = @("session_*", "trk_*", "diag_*", "dynamic_*", "prompt_*", "release_*", "headless_*")
$isPreview = -not $Execute
if ($DryRun -or $WhatIf) { $isPreview = $true }

if (-not (Test-Path -LiteralPath $Scratch)) {
    Write-Host "[CLEANUP] scratch missing: $Scratch (nothing to do)"
    exit 0
}

$cutoff = (Get-Date).AddHours(-[Math]::Abs($MaxAgeHours))
$candidates = @()

Get-ChildItem -LiteralPath $Scratch -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $name = $_.Name
    if ($name -ieq "uploads") { return }
    $match = $false
    foreach ($pat in $patterns) {
        if ($name -like $pat) { $match = $true; break }
    }
    if (-not $match) { return }
    if ($_.LastWriteTime -gt $cutoff) { return }
    $size = 0L
    Get-ChildItem -LiteralPath $_.FullName -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        $size += $_.Length
    }
    $candidates += [pscustomobject]@{
        Path = $_.FullName
        Name = $name
        LastWrite = $_.LastWriteTime
        SizeMB = [Math]::Round($size / 1MB, 2)
    }
}

Write-Host "[CLEANUP] scratch=$Scratch maxAgeHours=$MaxAgeHours preview=$isPreview"
Write-Host "[CLEANUP] never deletes scratch\uploads or releases\"
if ($candidates.Count -eq 0) {
    Write-Host "[CLEANUP] no session-like folders older than $MaxAgeHours h"
    exit 0
}

foreach ($item in $candidates) {
    $sizeText = "{0} MB" -f $item.SizeMB
    if ($isPreview) {
        Write-Host ("WOULD DELETE  {0,-40}  {1,10}  {2}" -f $item.Name, $sizeText, $item.LastWrite)
    } else {
        Write-Host ("DELETE        {0,-40}  {1,10}  {2}" -f $item.Name, $sizeText, $item.LastWrite)
        Remove-Item -LiteralPath $item.Path -Recurse -Force
    }
}

if ($isPreview) {
    Write-Host "[CLEANUP] dry-run complete. Pass -Execute to delete $($candidates.Count) folder(s)."
} else {
    Write-Host "[CLEANUP] deleted $($candidates.Count) folder(s)."
}
exit 0
