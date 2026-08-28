<#
.SYNOPSIS
    Register Hybrid 1.0 Master Pipeline as a Windows Scheduled Task
.DESCRIPTION
    Creates a daily scheduled task at 2:00 AM to run the master generation pipeline.
    Must be run with Administrator privileges.
#>

#Requires -RunAsAdministrator

$TaskName = "Hybrid_Master_Pipeline"
$ScriptPath = "D:\MusicDatasets\scripts\run_master_pipeline.ps1"

# Check if task already exists
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($ExistingTask) {
    Write-Host "[WARNING] Task '$TaskName' already exists. Removing and recreating..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Define action
$Action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-ExecutionPolicy Bypass -File `"$ScriptPath`""

# Define trigger (daily at 2:00 AM)
$Trigger = New-ScheduledTaskTrigger -Daily -At 02:00

# Define settings
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

# Define principal (run with highest privileges)
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Register the task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "Automated 7-minute audio render and hex locking pipeline."

Write-Host ""
Write-Host "==============================================================================" -ForegroundColor Green
Write-Host "[SUCCESS] Scheduled Task '$TaskName' registered successfully." -ForegroundColor Green
Write-Host "  - Runs daily at 02:00 AM" -ForegroundColor Cyan
Write-Host "  - Script: $ScriptPath" -ForegroundColor Cyan
Write-Host "  - View in Task Scheduler: taskschd.msc" -ForegroundColor Cyan
Write-Host "==============================================================================" -ForegroundColor Green
