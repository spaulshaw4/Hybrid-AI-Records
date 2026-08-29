# D:\MusicDatasets\scripts\restore_disaster_recovery.ps1
param(
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$BackupDir = "D:\MusicDatasets\archive\backups",
    [string]$BackupArchive = "",
    [switch]$RestoreConfigs = $true,
    [switch]$RestoreScripts = $true,
    [switch]$RestoreLogs = $false,
    [switch]$AutoRestartServices = $true,
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"

# Verify Administrator privileges for service orchestration
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($CurrentIdentity)

if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[ERROR] Administrator privileges required to restore files and manage services." -ForegroundColor Red
    Write-Host "Please re-run this script in an elevated PowerShell session." -ForegroundColor Yellow
    exit 1
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - DISASTER RECOVERY RESTORATION ENGINE" -ForegroundColor Cyan
Write-Host "Base Directory   : $BaseDir"
Write-Host "Execution Mode   : $(if ($DryRun) { '[DRY RUN - PREVIEW ONLY]' } else { '[LIVE RESTORE]' })"
Write-Host "================================================================" -ForegroundColor Cyan

# 1. Resolve Target Backup Archive
if (-not $BackupArchive) {
    Write-Host "[LOCATE] No backup archive specified. Scanning for latest bundle..."
    $LatestBackup = Get-ChildItem -Path $BackupDir -Filter "hybrid10_backup_*.zip" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if (-not $LatestBackup) {
        throw "No backup archives found in $BackupDir."
    }
    $TargetPath = $LatestBackup.FullName
} else {
    if (Test-Path $BackupArchive) {
        $TargetPath = (Get-Item $BackupArchive).FullName
    } elseif (Test-Path (Join-Path $BackupDir $BackupArchive)) {
        $TargetPath = (Join-Path $BackupDir $BackupArchive)
    } else {
        throw "Specified backup archive not found: $BackupArchive"
    }
}

$ArchiveFile = Get-Item $TargetPath
$ArchiveSizeMb = [math]::Round($ArchiveFile.Length / 1MB, 2)
Write-Host "[SELECTED] $TargetPath ($ArchiveSizeMb MB, Created: $($ArchiveFile.LastWriteTime))`n" -ForegroundColor Green

# 2. Stage Extraction Directory
$TempExtractDir = Join-Path $env:TEMP "hybrid_restore_stage_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Force -Path $TempExtractDir | Out-Null

try {
    Write-Host "[1/5] Extracting archive bundle into temporary sandbox..."
    Expand-Archive -Path $TargetPath -DestinationPath $TempExtractDir -Force
    Write-Host "  -> Archive extracted successfully." -ForegroundColor Green

    # 3. Stop Active Services Before Overwriting Executables
    $ManageScript = Join-Path "$BaseDir\scripts" "manage_all_services.ps1"

    if ($AutoRestartServices -and (-not $DryRun) -and (Test-Path $ManageScript)) {
        Write-Host "`n[2/5] Halting active services to release file locks..."
        & powershell.exe -ExecutionPolicy Bypass -File $ManageScript -Action stop
    } else {
        Write-Host "`n[2/5] Skipping daemon shutdown (DryRun or service manager not found)." -ForegroundColor Gray
    }

    # 4. Restore Configurations
    if ($RestoreConfigs) {
        Write-Host "`n[3/5] Restoring configuration files..."
        $SourceConfig = Join-Path $TempExtractDir "config"
        $DestConfig = Join-Path $BaseDir "config"

        if (Test-Path $SourceConfig) {
            if (-not (Test-Path $DestConfig)) { New-Item -ItemType Directory -Force -Path $DestConfig | Out-Null }

            $ConfigFiles = Get-ChildItem -Path $SourceConfig -File -Recurse
            foreach ($file in $ConfigFiles) {
                $relative = $file.FullName.Substring($SourceConfig.Length).TrimStart("\")
                $targetFile = Join-Path $DestConfig $relative
                $targetDir = Split-Path $targetFile -Parent

                if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }

                Write-Host "  -> [RESTORE CONFIG] $relative" -ForegroundColor Yellow
                if (-not $DryRun) {
                    Copy-Item -Path $file.FullName -Destination $targetFile -Force
                }
            }
        } else {
            Write-Host "  -> [SKIP] No config directory inside backup archive." -ForegroundColor Gray
        }
    }

    # 5. Restore Pipeline & Daemon Scripts
    if ($RestoreScripts) {
        Write-Host "`n[4/5] Restoring pipeline scripts and orchestration utilities..."
        $SourceScripts = Join-Path $TempExtractDir "scripts"
        $DestScripts = Join-Path $BaseDir "scripts"

        if (Test-Path $SourceScripts) {
            if (-not (Test-Path $DestScripts)) { New-Item -ItemType Directory -Force -Path $DestScripts | Out-Null }

            $ScriptFiles = Get-ChildItem -Path $SourceScripts -File -Recurse
            foreach ($file in $ScriptFiles) {
                $relative = $file.FullName.Substring($SourceScripts.Length).TrimStart("\")
                $targetFile = Join-Path $DestScripts $relative
                $targetDir = Split-Path $targetFile -Parent

                if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }

                Write-Host "  -> [RESTORE SCRIPT] $relative" -ForegroundColor Yellow
                if (-not $DryRun) {
                    Copy-Item -Path $file.FullName -Destination $targetFile -Force
                }
            }
        } else {
            Write-Host "  -> [SKIP] No scripts directory inside backup archive." -ForegroundColor Gray
        }
    }

    # Optional: Restore Diagnostic Logs
    if ($RestoreLogs) {
        Write-Host "`n[OPTIONAL] Restoring historical log files..."
        $SourceLogs = Join-Path $TempExtractDir "logs"
        $DestLogs = Join-Path $BaseDir "logs"

        if (Test-Path $SourceLogs) {
            if (-not (Test-Path $DestLogs)) { New-Item -ItemType Directory -Force -Path $DestLogs | Out-Null }

            $LogFiles = Get-ChildItem -Path $SourceLogs -File
            foreach ($file in $LogFiles) {
                Write-Host "  -> [RESTORE LOG] $($file.Name)" -ForegroundColor Gray
                if (-not $DryRun) {
                    Copy-Item -Path $file.FullName -Destination (Join-Path $DestLogs $file.Name) -Force
                }
            }
        }
    }

    # Report available DB snapshot data
    $DbSnapshots = Join-Path $TempExtractDir "database_snapshots"
    if (Test-Path $DbSnapshots) {
        $tables = Get-ChildItem -Path $DbSnapshots -Filter "*.json"
        if ($tables) {
            Write-Host "`n[INFO] Stored Database Snapshots present in archive:" -ForegroundColor Cyan
            foreach ($t in $tables) {
                Write-Host "  - $($t.Name) ($([math]::Round($t.Length / 1KB, 1)) KB)" -ForegroundColor Gray
            }
            Write-Host "  Note: these are exports for reference. Restoring them into Supabase" -ForegroundColor Gray
            Write-Host "  is deliberately manual, since re-inserting stale vault rows would" -ForegroundColor Gray
            Write-Host "  resurrect completed sessions and confuse the daemon poller." -ForegroundColor Gray
        }
    }

    # 6. Restart All Services & Run Diagnostics
    if ($AutoRestartServices -and (-not $DryRun) -and (Test-Path $ManageScript)) {
        Write-Host "`n[5/5] Re-initializing daemon services and running system checks..."
        & powershell.exe -ExecutionPolicy Bypass -File $ManageScript -Action start

        $VerifyScript = Join-Path "$BaseDir\scripts" "verify_pipeline_health.ps1"
        if (Test-Path $VerifyScript) {
            Start-Sleep -Seconds 2
            & powershell.exe -ExecutionPolicy Bypass -File $VerifyScript
        }
    }

} finally {
    # Cleanup scratchpad
    if (Test-Path $TempExtractDir) {
        Remove-Item -Path $TempExtractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "RESTORATION COMPLETED" -ForegroundColor Green
Write-Host "Source Archive : $($ArchiveFile.Name)"
Write-Host "Target Volume  : $BaseDir"
Write-Host "================================================================" -ForegroundColor Cyan
