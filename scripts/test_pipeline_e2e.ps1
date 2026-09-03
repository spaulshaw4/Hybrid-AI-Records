# End-to-end diagnostic for the headless -> scratch mix -> master path.
# Default skips the 3-minute master. Pass -RunMaster to call run_master_pipeline.ps1.
param(
    [string]$SessionId = ("e2e_" + (Get-Date -Format "yyyyMMdd_HHmmss")),
    [string]$GenreLock = "alt_rock",
    [string]$Prompt = "offline e2e diagnostic alt rock instrumental",
    [string]$BaseDir = "D:\MusicDatasets",
    [switch]$DryRun,
    [switch]$SkipMaster,
    [switch]$RunMaster
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ResolveScript = Join-Path $PSScriptRoot "resolve_python.ps1"
if (-not (Test-Path $ResolveScript)) {
    $ResolveScript = Join-Path $BaseDir "scripts\resolve_python.ps1"
}
if (-not (Test-Path $ResolveScript)) {
    Write-Host "[FATAL] resolve_python.ps1 is missing." -ForegroundColor Red
    exit 1
}
. $ResolveScript
$PythonExe = Get-HybridPython -Quiet
if (-not $PythonExe) {
    Write-Host "[FATAL] Get-HybridPython found no usable interpreter (WindowsApps stubs are rejected)." -ForegroundColor Red
    exit 1
}

$LogDir = Join-Path $BaseDir "logs"
$LogPath = Join-Path $LogDir "e2e_diagnostic.log"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$script:FailCount = 0
$script:WarnCount = 0
$DoMaster = $false
if ($RunMaster -and -not $SkipMaster -and -not $DryRun) {
    $DoMaster = $true
}
$SkipHeavy = -not $DoMaster

function Write-E2eLog {
    param(
        [string]$Level,
        [string]$Message
    )
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$stamp] [$Level] $Message"
    try {
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    } catch {
    }
    switch ($Level) {
        "FAIL" { Write-Host $line -ForegroundColor Red }
        "WARN" { Write-Host $line -ForegroundColor Yellow }
        "OK"   { Write-Host $line -ForegroundColor Green }
        default { Write-Host $line }
    }
}

function Record-Step {
    param(
        [ValidateSet("OK", "WARN", "FAIL")]
        [string]$Status,
        [string]$Message
    )
    Write-E2eLog -Level $Status -Message $Message
    if ($Status -eq "FAIL") { $script:FailCount++ }
    if ($Status -eq "WARN") { $script:WarnCount++ }
}

function Resolve-ExistingFile {
    param([string[]]$Candidates)
    foreach ($path in $Candidates) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            return (Resolve-Path -LiteralPath $path).Path
        }
    }
    return $null
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host " HYBRID E2E PIPELINE DIAGNOSTIC" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-E2eLog -Level "INFO" -Message "session=$SessionId genre=$GenreLock python=$PythonExe"
if ($DoMaster) {
    Write-E2eLog -Level "INFO" -Message "mode=RunMaster log=$LogPath"
} elseif ($DryRun) {
    Write-E2eLog -Level "INFO" -Message "mode=DryRun log=$LogPath"
} else {
    Write-E2eLog -Level "INFO" -Message "mode=SkipMaster/default log=$LogPath"
}

# -------------------------------------------------------------------------
# 1. Corpus index row count
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "[1] Corpus SQLite" -ForegroundColor Cyan
$DbCandidates = @(
    (Join-Path $BaseDir "db\corpus_index.sqlite"),
    (Join-Path $BaseDir "database\corpus_index.sqlite")
)
$DbPath = Resolve-ExistingFile -Candidates $DbCandidates
if (-not $DbPath) {
    Record-Step -Status FAIL -Message ("corpus_index.sqlite missing. Checked: " + ($DbCandidates -join " | "))
} else {
    $countFile = Join-Path $env:TEMP "hybrid_e2e_db_count.py"
    $countBody = @(
        "import sqlite3, sys",
        "con = sqlite3.connect(sys.argv[1])",
        "names = {row[0] for row in con.execute(""SELECT name FROM sqlite_master WHERE type='table'"")}",
        "if 'slice_index' in names:",
        "    n = con.execute('SELECT COUNT(*) FROM slice_index').fetchone()[0]",
        "    print('slice_index', int(n))",
        "else:",
        "    print('no_slice_index', 0)"
    ) -join "`n"
    Set-Content -Path $countFile -Value $countBody -Encoding UTF8
    $dbOut = & $PythonExe $countFile $DbPath 2>&1
    $dbText = ("$dbOut").Trim()
    if ($LASTEXITCODE -ne 0) {
        Record-Step -Status FAIL -Message "SQLite count failed at $DbPath : $dbText"
    } else {
        Record-Step -Status OK -Message "DB $DbPath -> $dbText"
    }
}

# -------------------------------------------------------------------------
# 2. Expected files (New-Item only for the log directory we own)
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "[2] Path existence" -ForegroundColor Cyan
$HeadlessPy = Resolve-ExistingFile -Candidates @(
    (Join-Path $RepoRoot "engine\generate_track_headless.py"),
    (Join-Path $BaseDir "engine\generate_track_headless.py")
)
$PipelinePs1 = Resolve-ExistingFile -Candidates @(
    (Join-Path $PSScriptRoot "run_master_pipeline.ps1"),
    (Join-Path $BaseDir "scripts\run_master_pipeline.ps1")
)
$EncoderPy = Resolve-ExistingFile -Candidates @(
    (Join-Path $PSScriptRoot "multi_format_encoder.py"),
    (Join-Path $BaseDir "scripts\multi_format_encoder.py")
)

$ScratchSession = Join-Path $BaseDir ("scratch\" + $SessionId)
$UnmasteredMix = Join-Path $ScratchSession "unmastered_mix.wav"
$UnmasteredNamed = Join-Path $ScratchSession ($SessionId + "_unmastered.wav")
$MasterWav = Join-Path $BaseDir ("renders\" + $SessionId + "\master_output.wav")
$MasterMp3Legacy = Join-Path $BaseDir ("renders\" + $SessionId + "\" + $SessionId + "_master.mp3")

if ($HeadlessPy) {
    Record-Step -Status OK -Message "headless present: $HeadlessPy"
} else {
    Record-Step -Status WARN -Message "generate_track_headless.py not in repo engine or workstation engine"
}
if ($PipelinePs1) {
    Record-Step -Status OK -Message "master orchestrator present: $PipelinePs1"
} else {
    Record-Step -Status FAIL -Message "run_master_pipeline.ps1 not found"
}
if ($EncoderPy) {
    Record-Step -Status OK -Message "optional encoder present: $EncoderPy"
} else {
    Record-Step -Status WARN -Message "multi_format_encoder.py absent; MP3 encode will be skipped"
}

Write-E2eLog -Level "INFO" -Message "unmastered_mix expected: $UnmasteredMix"
Write-E2eLog -Level "INFO" -Message "unmastered named fallback: $UnmasteredNamed"
Write-E2eLog -Level "INFO" -Message "master wav expected: $MasterWav"
Write-E2eLog -Level "INFO" -Message "legacy mp3 is not the deliverable: $MasterMp3Legacy"

# -------------------------------------------------------------------------
# 3. Optional offline headless (not the 3-minute master)
# -------------------------------------------------------------------------
$HeadlessWav = $null
$HeadlessSeconds = 0.0
if ($HeadlessPy) {
    Write-Host ""
    Write-Host "[3] Headless --offline" -ForegroundColor Cyan
    $scratchParent = Join-Path $BaseDir "scratch"
    if (-not (Test-Path $scratchParent)) {
        New-Item -ItemType Directory -Force -Path $scratchParent | Out-Null
    }
    $headlessDb = $DbPath
    if (-not $headlessDb) { $headlessDb = $DbCandidates[0] }
    $headlessArgs = @(
        $HeadlessPy,
        "--prompt", $Prompt,
        "--session", $SessionId,
        "--offline",
        "--scratch", (Join-Path $BaseDir "scratch"),
        "--db", $headlessDb,
        "--max-per-stem", "2",
        "--max-stage", "8"
    )
    Write-E2eLog -Level "INFO" -Message ("invoking " + ($headlessArgs -join " "))
    & $PythonExe @headlessArgs
    $headExit = $LASTEXITCODE
    if ($headExit -ne 0) {
        Record-Step -Status WARN -Message "headless --offline exited $headExit (corpus/index may be empty on this machine)"
    }
    if (Test-Path -LiteralPath $UnmasteredMix) {
        $HeadlessWav = $UnmasteredMix
    } elseif (Test-Path -LiteralPath $UnmasteredNamed) {
        $HeadlessWav = $UnmasteredNamed
        Write-E2eLog -Level "INFO" -Message "named unmastered exists; pipeline still expects unmastered_mix.wav"
    }
    if ($HeadlessWav) {
        $durFile = Join-Path $env:TEMP "hybrid_e2e_wav_dur.py"
        $durBody = @(
            "import sys, wave",
            "w = wave.open(sys.argv[1])",
            "print(w.getnframes() / float(w.getframerate() or 1))"
        ) -join "`n"
        Set-Content -Path $durFile -Value $durBody -Encoding UTF8
        $durOut = & $PythonExe $durFile $HeadlessWav 2>&1
        try { $HeadlessSeconds = [double](("$durOut").Trim()) } catch { $HeadlessSeconds = 0.0 }
        $durMsg = "unmastered wav $HeadlessWav duration=" + ("{0:N2}" -f $HeadlessSeconds) + "s"
        Record-Step -Status OK -Message $durMsg
    } else {
        Record-Step -Status WARN -Message "no unmastered wav at expected scratch paths"
    }
} else {
    Write-E2eLog -Level "INFO" -Message "skipping headless; module not on disk"
}

# -------------------------------------------------------------------------
# 4. Master (opt-in only)
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "[4] Master pipeline" -ForegroundColor Cyan
if ($SkipHeavy) {
    Write-E2eLog -Level "INFO" -Message "skipping run_master_pipeline.ps1 (default dry / -SkipMaster; pass -RunMaster to execute)"
} elseif (-not $PipelinePs1) {
    Record-Step -Status FAIL -Message "cannot -RunMaster; orchestrator missing"
} else {
    Write-E2eLog -Level "INFO" -Message "calling run_master_pipeline.ps1"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $PipelinePs1 -SessionId $SessionId -GenreLock $GenreLock
    if ($LASTEXITCODE -ne 0) {
        Record-Step -Status FAIL -Message "run_master_pipeline.ps1 exited $LASTEXITCODE"
    }
    if (Test-Path -LiteralPath $MasterWav) {
        Record-Step -Status OK -Message "master wav present: $MasterWav"
        if ($EncoderPy) {
            $mp3Dir = Split-Path $MasterWav -Parent
            & $PythonExe $EncoderPy --input $MasterWav --title $SessionId --genre $GenreLock --out-dir $mp3Dir --targets mp3
            if ($LASTEXITCODE -eq 0) {
                Record-Step -Status OK -Message "multi_format_encoder.py wrote MP3 beside the wav"
            } else {
                Record-Step -Status WARN -Message "MP3 encode failed or ffmpeg missing"
            }
        }
    } else {
        Record-Step -Status FAIL -Message "master_output.wav missing (legacy SessionId_master.mp3 is not the pipeline deliverable)"
    }
}

# -------------------------------------------------------------------------
# Summary. Do not print HEALTHY/COMPLIANT after a failed step.
# -------------------------------------------------------------------------
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
$summary = "fails=$($script:FailCount) warns=$($script:WarnCount) python=$PythonExe db=$DbPath mix=$HeadlessWav master_checked=$MasterWav"
Write-E2eLog -Level "INFO" -Message $summary
if ($script:FailCount -gt 0) {
    Write-Host "[E2E RESULT] FAILED" -ForegroundColor Red
    Write-Host $summary
    Write-Host "Log: $LogPath" -ForegroundColor Yellow
    exit 1
}
if ($script:WarnCount -gt 0) {
    Write-Host "[E2E RESULT] PASSED WITH WARNINGS" -ForegroundColor Yellow
    Write-Host $summary
    Write-Host "Log: $LogPath"
    exit 0
}
Write-Host "[E2E RESULT] PASSED" -ForegroundColor Green
Write-Host $summary
Write-Host "Log: $LogPath"
exit 0
