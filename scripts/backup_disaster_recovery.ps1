# D:\MusicDatasets\scripts\backup_disaster_recovery.ps1
param(
    [string]$BaseDir = "D:\MusicDatasets",
    [string]$BackupDir = "D:\MusicDatasets\archive\backups",
    [int]$RetentionDays = 14,
    [switch]$IncludeFullLogs = $false
)

$ErrorActionPreference = "Stop"

$Timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
$ArchiveName = "hybrid10_backup_$Timestamp"
$TempStageDir = Join-Path $env:TEMP "hybrid_backup_stage_$Timestamp"
$FinalZipPath = Join-Path $BackupDir "$ArchiveName.zip"
$TelemetryScript = Join-Path "$BaseDir\scripts" "log_telemetry.py"

$sbUrl = $env:SUPABASE_URL
$sbKey = $env:SUPABASE_SERVICE_ROLE_KEY

$ArchiveSizeMb = 0

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - AUTOMATED DISASTER RECOVERY & SNAPSHOT ENGINE" -ForegroundColor Cyan
Write-Host "Snapshot ID  : $ArchiveName"
Write-Host "Target Vault : $FinalZipPath"
Write-Host "Retention    : Purge backups older than $RetentionDays days"
Write-Host "================================================================" -ForegroundColor Cyan

# 1. Ensure directories exist
if (!(Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
}

if (Test-Path $TempStageDir) {
    Remove-Item -Path $TempStageDir -Recurse -Force | Out-Null
}
New-Item -ItemType Directory -Force -Path $TempStageDir | Out-Null

$StageConfig = New-Item -ItemType Directory -Force -Path (Join-Path $TempStageDir "config")
$StageScripts = New-Item -ItemType Directory -Force -Path (Join-Path $TempStageDir "scripts")
$StageGrafana = New-Item -ItemType Directory -Force -Path (Join-Path $TempStageDir "monitoring\grafana")
$StageLogs = New-Item -ItemType Directory -Force -Path (Join-Path $TempStageDir "logs")
$StageDatabase = New-Item -ItemType Directory -Force -Path (Join-Path $TempStageDir "database_snapshots")

try {
    # -------------------------------------------------------------------------
    # 2. STAGE CONFIGURATIONS & ALERTS
    # -------------------------------------------------------------------------
    Write-Host "`n[1/6] Backing up configuration files..."
    $ConfigDir = Join-Path $BaseDir "config"

    if (Test-Path $ConfigDir) {
        Copy-Item -Path "$ConfigDir\*" -Destination $StageConfig.FullName -Recurse -Force
        Write-Host "  -> Bundled configuration & Prometheus alerting rules." -ForegroundColor Green
    } else {
        Write-Host "  -> [WARN] Config directory not found at $ConfigDir" -ForegroundColor Yellow
    }

    # -------------------------------------------------------------------------
    # 2b. STAGE GRAFANA PROVISIONING & DASHBOARDS
    # -------------------------------------------------------------------------
    Write-Host "`n[2/6] Backing up Grafana provisioning configs and dashboard templates..."
    $GrafanaBase = Join-Path $BaseDir "monitoring\grafana"

    if (Test-Path $GrafanaBase) {
        Copy-Item -Path "$GrafanaBase\*" -Destination $StageGrafana.FullName -Recurse -Force
        Write-Host "  -> Bundled provisioning providers and dashboard JSON models." -ForegroundColor Green
    } else {
        Write-Host "  -> [WARN] Grafana monitoring tree not found at $GrafanaBase" -ForegroundColor Yellow
    }

    # -------------------------------------------------------------------------
    # 3. STAGE ORCHESTRATION & DAEMON SCRIPTS
    # -------------------------------------------------------------------------
    Write-Host "`n[3/6] Backing up pipeline scripts & orchestration binaries..."
    $ScriptsDir = Join-Path $BaseDir "scripts"

    if (Test-Path $ScriptsDir) {
        # -Include requires a wildcard in -Path (or -Recurse); passing a bare
        # directory silently matches nothing.
        $staged = 0
        Get-ChildItem -Path (Join-Path $ScriptsDir "*") -Include *.py, *.ps1, *.bat, *.sql, *.json -File | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination $StageScripts.FullName -Force
            $staged++
        }
        Write-Host "  -> Staged $staged Python daemons and PowerShell utilities." -ForegroundColor Green

        if ($staged -eq 0) {
            Write-Host "  -> [WARN] No scripts matched in $ScriptsDir" -ForegroundColor Yellow
        }
    }

    # -------------------------------------------------------------------------
    # 4. EXPORT SUPABASE LEDGER & TELEMETRY TABLES
    # -------------------------------------------------------------------------
    Write-Host "`n[4/6] Generating cloud ledger database snapshots..."

    if ($sbUrl -and $sbKey) {
        $Headers = @{
            "apikey"        = $sbKey
            "Authorization" = "Bearer $sbKey"
            "Content-Type"  = "application/json"
        }

        $TablesToExport = @("user_vaults", "pipeline_telemetry_logs", "audio_slices")

        foreach ($table in $TablesToExport) {
            try {
                $endpoint = "$sbUrl/rest/v1/$table?select=*&order=created_at.desc&limit=10000"
                $data = Invoke-RestMethod -Uri $endpoint -Headers $Headers -Method Get -TimeoutSec 30
                $jsonOut = Join-Path $StageDatabase.FullName "$table.json"
                $data | ConvertTo-Json -Depth 10 | Out-File -FilePath $jsonOut -Encoding utf8
                Write-Host "  -> Exported $($data.Count) records from '$table' to $table.json" -ForegroundColor Green
            } catch {
                Write-Host "  -> [WARN] Database snapshot failed for table $table : $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "  -> [SKIP] Supabase credentials not found in environment." -ForegroundColor Gray
    }

    # -------------------------------------------------------------------------
    # 5. STAGE SYSTEM LOGS
    # -------------------------------------------------------------------------
    Write-Host "`n[5/6] Capturing system daemon log snapshots..."
    $LogsDir = Join-Path $BaseDir "logs"

    if (Test-Path $LogsDir) {
        Get-ChildItem -Path $LogsDir -Filter "*.log" -File | ForEach-Object {
            if ($IncludeFullLogs) {
                Copy-Item -Path $_.FullName -Destination $StageLogs.FullName -Force
            } else {
                # Snapshot the trailing 500 lines per log to keep backups lean
                $tailPath = Join-Path $StageLogs.FullName $_.Name
                Get-Content -Path $_.FullName -Tail 500 | Out-File -FilePath $tailPath -Encoding utf8
            }
        }
        Write-Host "  -> Staged daemon diagnostic logs." -ForegroundColor Green
    }

    # -------------------------------------------------------------------------
    # 6. COMPRESS ARCHIVE
    # -------------------------------------------------------------------------
    Write-Host "`n[6/6] Compressing disaster recovery bundle into ZIP..."
    Compress-Archive -Path "$TempStageDir\*" -DestinationPath $FinalZipPath -CompressionLevel Optimal -Force

    $ArchiveSizeMb = [math]::Round((Get-Item $FinalZipPath).Length / 1MB, 2)
    Write-Host "  -> Backup bundle created: $FinalZipPath ($ArchiveSizeMb MB)" -ForegroundColor Green

} finally {
    # Clean up staging scratchpad
    if (Test-Path $TempStageDir) {
        Remove-Item -Path $TempStageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# -------------------------------------------------------------------------
# 7. ENFORCE ROTATION & RETENTION POLICY
# -------------------------------------------------------------------------
Write-Host "`n[ROTATION] Checking retention window ($RetentionDays days)..."

$CutoffDate = (Get-Date).AddDays(-$RetentionDays)
$OldBackups = Get-ChildItem -Path $BackupDir -Filter "hybrid10_backup_*.zip" | Where-Object { $_.LastWriteTime -lt $CutoffDate }
$PurgedBackups = 0

foreach ($oldZip in $OldBackups) {
    Write-Host "  [PURGE] Removing expired backup: $($oldZip.Name)" -ForegroundColor Yellow
    Remove-Item -Path $oldZip.FullName -Force
    $PurgedBackups++
}

if ($PurgedBackups -eq 0) {
    Write-Host "  -> All existing backup bundles remain within retention threshold." -ForegroundColor Gray
}

# -------------------------------------------------------------------------
# 8. EMIT TELEMETRY LOG
# -------------------------------------------------------------------------
if (Test-Path $TelemetryScript) {
    . "$PSScriptRoot\resolve_python.ps1"
    $python = Get-HybridPython -Quiet

    if ($python) {
        $metaJson = "{`"backup_file`":`"$ArchiveName.zip`",`"size_mb`":$ArchiveSizeMb,`"purged_old_backups`":$PurgedBackups}"
        & $python $TelemetryScript --event "backup_completed" --user "00000000-0000-0000-0000-000000000001" --metadata $metaJson
    } else {
        Write-Host "[WARN] No usable Python found; backup telemetry not emitted." -ForegroundColor Yellow
    }
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "DISASTER RECOVERY BACKUP COMPLETED SUCCESSFULLY" -ForegroundColor Green
Write-Host "Vault Archive : $FinalZipPath"
Write-Host "Bundle Size   : $ArchiveSizeMb MB"
Write-Host "================================================================" -ForegroundColor Cyan
