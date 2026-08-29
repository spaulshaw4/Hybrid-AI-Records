# D:\MusicDatasets\scripts\register_backup_task.ps1
# Schedules the disaster recovery snapshot to run daily at 02:00

$TaskName = "HybridDisasterRecoveryBackup"
$ScriptPath = "D:\MusicDatasets\scripts\backup_disaster_recovery.ps1"

if (-not (Test-Path $ScriptPath)) {
    Write-Host "[ERROR] $ScriptPath not found. Run deploy_to_workstation.ps1 first." -ForegroundColor Red
    exit 1
}

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$ScriptPath`" -RetentionDays 14"
$Trigger = New-ScheduledTaskTrigger -Daily -At "02:00"
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Force

Write-Host "[SUCCESS] Disaster recovery backup task scheduled daily at 02:00 (14-day retention)." -ForegroundColor Green

# Running as SYSTEM means the task inherits only machine-scoped environment
# variables. If SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY were set at User scope,
# the ledger export in step 3 will silently skip.
$machineUrl = [Environment]::GetEnvironmentVariable("SUPABASE_URL", "Machine")
$machineKey = [Environment]::GetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY", "Machine")

if (-not $machineUrl -or -not $machineKey) {
    Write-Host "`n[WARN] Supabase credentials are not set at Machine scope." -ForegroundColor Yellow
    Write-Host "       This task runs as SYSTEM and will not see User-scoped variables," -ForegroundColor Yellow
    Write-Host "       so the database snapshot step will be skipped. Set them with:" -ForegroundColor Yellow
    Write-Host '       [Environment]::SetEnvironmentVariable("SUPABASE_URL","<url>","Machine")' -ForegroundColor Gray
    Write-Host '       [Environment]::SetEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY","<key>","Machine")' -ForegroundColor Gray
}
