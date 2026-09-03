# Freesound API-key scrub watchdog.
# Polls until CC0 music/speech downloaders exit, then clears User-scope
# FREESOUND_API_KEY / FREESOUND_TOKEN and assignment lines in scripts.
# NEVER deletes downloaded audio (raw\freesound_cc0_music / freesound_cc0_speech).
# Does not stop slicers or downloaders.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$LogPath = "D:\MusicDatasets\logs\freesound_key_scrub.log"
$PollSeconds = 45
$ScriptRoots = @(
    "D:\MusicDatasets",
    "D:\MusicDatasets\scripts",
    "C:\Users\spaul\Downloads\Hybrid AI Forge (10)\scripts",
    "C:\Users\spaul\Downloads\Hybrid AI Forge (10)"
)
$AudioRoots = @(
    "D:\MusicDatasets\raw\freesound_cc0_music",
    "D:\MusicDatasets\raw\freesound_cc0_speech"
)
$EnvNames = @("FREESOUND_API_KEY", "FREESOUND_TOKEN")

function Write-ScrubLog {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $Message"
    try {
        $dir = Split-Path -Parent $LogPath
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    } catch { }
    Write-Host $line
}

function Get-FreesoundDownloaderProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            ($_.CommandLine -match 'download_cc0_music' -or $_.CommandLine -match 'download_cc0_speech')
        }
}

function Protect-AudioTrees {
    foreach ($root in $AudioRoots) {
        if (Test-Path $root) {
            Write-ScrubLog "KEEP audio tree: $root"
        } else {
            Write-ScrubLog "audio tree not present (ok): $root"
        }
    }
}

function Test-PlaceholderValue {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
    $v = $Value.Trim().Trim("'").Trim('"')
    if ($v -match '^(<your key>|YOUR_KEY|changeme|placeholder|xxx+|<.*>)$') { return $true }
    if ($v.Length -lt 8) { return $true }
    return $false
}

function Remove-AssignmentLinesFromFile {
    param([string]$Path)
    $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($ext -notin @(".py", ".ps1", ".env") -and ([IO.Path]::GetFileName($Path) -notlike ".env*")) {
        return 0
    }
    foreach ($audio in $AudioRoots) {
        if ($Path.StartsWith($audio, [StringComparison]::OrdinalIgnoreCase)) { return 0 }
    }
    try {
        $raw = [IO.File]::ReadAllText($Path)
    } catch {
        return 0
    }
    $lines = $raw -split "`r`n|`n|`r", -1
    $keep = New-Object System.Collections.Generic.List[string]
    $removed = 0
    foreach ($line in $lines) {
        $trim = $line.Trim()
        $drop = $false
        if ($trim -match '^(?:export\s+)?FREESOUND_(?:API_KEY|TOKEN)\s*=') {
            $rhs = ($trim -split '=', 2)[1]
            if (-not (Test-PlaceholderValue $rhs)) { $drop = $true }
        }
        elseif ($trim -match '^\$env:FREESOUND_(?:API_KEY|TOKEN)\s*=') {
            $rhs = ($trim -split '=', 2)[1]
            if (-not (Test-PlaceholderValue $rhs)) { $drop = $true }
        }
        if ($drop) { $removed++; continue }
        $keep.Add($line)
    }
    if ($removed -gt 0) {
        $nl = if ($raw -match "`r`n") { "`r`n" } else { "`n" }
        $out = [string]::Join($nl, $keep.ToArray())
        [IO.File]::WriteAllText($Path, $out)
        Write-ScrubLog "scrubbed $removed assignment line(s) from $Path"
    }
    return $removed
}

function Invoke-ScriptScrub {
    $total = 0
    $files = New-Object System.Collections.Generic.List[string]
    foreach ($root in $ScriptRoots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem -Path $root -File -Force -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Extension -in @(".py", ".ps1", ".env") -or $_.Name -like ".env*"
            } | ForEach-Object { $files.Add($_.FullName) }
    }
    $unique = $files | Select-Object -Unique
    foreach ($f in $unique) {
        $total += Remove-AssignmentLinesFromFile -Path $f
    }
    Write-ScrubLog "script assignment scrub complete; lines_removed=$total files_considered=$($unique.Count)"
}

function Clear-UserFreesoundEnv {
    foreach ($name in $EnvNames) {
        $existing = [Environment]::GetEnvironmentVariable($name, "User")
        if ([string]::IsNullOrEmpty($existing)) {
            Write-ScrubLog "User env $name already absent"
        } else {
            [Environment]::SetEnvironmentVariable($name, $null, "User")
            Write-ScrubLog "removed User env $name (value not logged)"
        }
        $still = [Environment]::GetEnvironmentVariable($name, "User")
        if ([string]::IsNullOrEmpty($still)) {
            Write-ScrubLog "confirm User env $name cleared"
        } else {
            Write-ScrubLog "WARN User env $name still present after clear"
        }
    }
}

Write-ScrubLog "watchdog start pid=$PID poll=${PollSeconds}s"
Write-ScrubLog "will NOT delete mp3 trees; will NOT stop slicers"
Protect-AudioTrees

while ($true) {
    $procs = @(Get-FreesoundDownloaderProcesses)
    if ($procs.Count -eq 0) {
        Write-ScrubLog "no download_cc0_music / download_cc0_speech python processes; proceeding to scrub"
        break
    }
    $ids = ($procs | ForEach-Object { $_.ProcessId }) -join ","
    Write-ScrubLog "downloaders still running: count=$($procs.Count) pids=$ids (command-line match; not PID-only)"
    Start-Sleep -Seconds $PollSeconds
}

Protect-AudioTrees
Clear-UserFreesoundEnv
Invoke-ScriptScrub
Protect-AudioTrees

Write-ScrubLog "ROTATE REMINDER: rotate the Freesound API token at https://freesound.org/apiv2/apply/ if it may have been exposed. Local User env was cleared; downloaded audio was kept."
Write-ScrubLog "watchdog done pid=$PID"
