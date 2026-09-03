# Hybrid AI Records - production daemon matrix + storage health.
param(
    [string]$BaseDir = "D:\MusicDatasets",
    [double]$MinFreeGb = 50.0
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $RepoRoot "scripts\resolve_python.ps1")

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " HYBRID AI RECORDS - FULL SYSTEM READINESS DIAGNOSTICS   " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Execution Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

$script:FailCount = 0
$script:WarnCount = 0

function Write-Check {
    param(
        [ValidateSet("OK", "WARN", "FAIL")]
        [string]$Status,
        [string]$Label,
        [string]$Detail
    )
    switch ($Status) {
        "OK" {
            Write-Host "  [OK]    $Label - $Detail" -ForegroundColor Green
        }
        "WARN" {
            Write-Host "  [WARN]  $Label - $Detail" -ForegroundColor Yellow
            $script:WarnCount++
        }
        "FAIL" {
            Write-Host "  [FAIL]  $Label - $Detail" -ForegroundColor Red
            $script:FailCount++
        }
    }
}

# 1. Daemon matrix (8 core NSSM services)
$Services = @(
    "HybridAlertBridgeDaemon",
    "HybridAlertmanagerDaemon",
    "HybridAudioDaemon",
    "HybridPrometheusDaemon",
    "HybridPrometheusExporterDaemon",
    "HybridStagnationHealerDaemon",
    "HybridStorageGuardDaemon",
    "HybridWatchdogDaemon"
)

Write-Host ""
Write-Host "[1] NSSM daemon matrix" -ForegroundColor Cyan
foreach ($svc in $Services) {
    $serviceObj = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($serviceObj -and $serviceObj.Status -eq "Running") {
        Write-Check -Status OK -Label $svc -Detail "RUNNING"
    } elseif ($serviceObj) {
        Write-Check -Status FAIL -Label $svc -Detail "installed but $($serviceObj.Status)"
    } else {
        Write-Check -Status FAIL -Label $svc -Detail "NOT REGISTERED"
    }
}

$macro = Get-Service -Name "HybridHardwareMacroDaemon" -ErrorAction SilentlyContinue
if ($macro -and $macro.Status -eq "Running") {
    Write-Check -Status OK -Label "HybridHardwareMacroDaemon" -Detail "RUNNING (optional)"
} elseif ($macro) {
    Write-Check -Status WARN -Label "HybridHardwareMacroDaemon" -Detail "installed but $($macro.Status)"
}

# 2. Unbuffered Python logging on NSSM services
Write-Host ""
Write-Host "[2] NSSM unbuffered logging" -ForegroundColor Cyan
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
    Write-Check -Status WARN -Label "NSSM" -Detail "nssm.exe not on PATH - cannot inspect AppParameters"
} else {
    foreach ($svc in $Services) {
        if (-not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) { continue }
        $params = (& nssm get $svc AppParameters 2>$null | Out-String).Trim()
        $envExtra = (& nssm get $svc AppEnvironmentExtra 2>$null | Out-String)
        $rotate = (& nssm get $svc AppRotateFiles 2>$null | Out-String).Trim()
        $hasDashU = $params -match '(^|\s)-u(\s|$)'
        $hasUnbuf = $envExtra -match 'PYTHONUNBUFFERED\s*=\s*1'
        if (($hasDashU -or $hasUnbuf) -and $rotate -eq "1") {
            Write-Check -Status OK -Label "$svc logging" -Detail "PYTHONUNBUFFERED + rotate"
        } elseif ($rotate -eq "1") {
            Write-Check -Status WARN -Label "$svc logging" -Detail "rotation on; add PYTHONUNBUFFERED=1 or python -u"
        } else {
            Write-Check -Status WARN -Label "$svc logging" -Detail "rotation/unbuffered not confirmed"
        }
    }
}

# 3. SQLite + WAL
Write-Host ""
Write-Host "[3] SQLite catalog + WAL" -ForegroundColor Cyan
$DbPath = Join-Path $BaseDir "database\master_catalog.db"
$PythonExe = Get-HybridPython -Quiet
if (-not $PythonExe) { $PythonExe = $env:HYBRID_PYTHON }

if (Test-Path $DbPath) {
    Write-Check -Status OK -Label "master_catalog.db" -Detail $DbPath
    if ($PythonExe) {
        $walScript = Join-Path $RepoRoot "scripts\check_sqlite_wal.py"
        $wal = & $PythonExe $walScript $DbPath 2>$null
        $walMode = ("$wal").Trim().ToLower()
        if ($walMode -eq "wal") {
            Write-Check -Status OK -Label "SQLite WAL" -Detail "journal_mode=wal"
        } else {
            Write-Check -Status WARN -Label "SQLite WAL" -Detail "journal_mode=$walMode (expected wal)"
        }
    } else {
        Write-Check -Status WARN -Label "SQLite WAL" -Detail "Python not resolved - skipped PRAGMA"
    }
} else {
    Write-Check -Status FAIL -Label "master_catalog.db" -Detail "missing at $DbPath"
}

# 4. Scratch NVMe
Write-Host ""
Write-Host "[4] Scratch storage" -ForegroundColor Cyan
$Drive = Get-PSDrive D -ErrorAction SilentlyContinue
if ($Drive) {
    $FreeSpaceGB = [math]::Round($Drive.Free / 1GB, 2)
    if ($FreeSpaceGB -gt $MinFreeGb) {
        Write-Check -Status OK -Label "D: free space" -Detail "$FreeSpaceGB GB"
    } else {
        Write-Check -Status WARN -Label "D: free space" -Detail "$FreeSpaceGB GB remaining (threshold $MinFreeGb GB)"
    }
} else {
    Write-Check -Status FAIL -Label "D: volume" -Detail "not mounted"
}

# 5. S3 vault
Write-Host ""
Write-Host "[5] S3 vault connectivity" -ForegroundColor Cyan
if (-not $PythonExe) {
    Write-Check -Status FAIL -Label "S3 vault" -Detail "no real Python interpreter (venv path is not used)"
} else {
    $probe = Join-Path $RepoRoot "scripts\check_s3_vault.py"
    $s3Out = & $PythonExe $probe 2>&1
    $vaultLine = ($s3Out | Select-String -Pattern '^VAULT:' | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $vaultLine) {
        $vaults = ($vaultLine.Line -replace '^VAULT:', '')
        if ($vaults) {
            Write-Check -Status OK -Label "S3 vault" -Detail "reachable ($vaults)"
        } else {
            Write-Check -Status WARN -Label "S3 vault" -Detail "credentials work; no bucket name contains vault"
        }
    } else {
        $err = ($s3Out | Out-String).Trim()
        if ($err.Length -gt 180) { $err = $err.Substring(0, 180) }
        Write-Check -Status FAIL -Label "S3 vault" -Detail $err
    }
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
if ($script:FailCount -eq 0) {
    Write-Host " READY FOR INLINE MASTER PRODUCTION: Phase Target 0.85+ " -ForegroundColor Green
    if ($script:WarnCount -gt 0) {
        Write-Host " $($script:WarnCount) warning(s) - production can proceed with caution." -ForegroundColor Yellow
    }
    Write-Host "==========================================================" -ForegroundColor Cyan
    exit 0
}

Write-Host " NOT READY: $($script:FailCount) check(s) failed, $($script:WarnCount) warning(s)." -ForegroundColor Red
Write-Host "==========================================================" -ForegroundColor Cyan
exit 1
