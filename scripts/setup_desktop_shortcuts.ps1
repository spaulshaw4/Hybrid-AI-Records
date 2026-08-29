# D:\MusicDatasets\scripts\setup_desktop_shortcuts.ps1
$ErrorActionPreference = "Stop"

$DesktopPath = [Environment]::GetFolderPath("Desktop")
$WshShell = New-Object -ComObject WScript.Shell

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - DESKTOP SHORTCUT CONFIGURATOR" -ForegroundColor Cyan
Write-Host "Target Desktop: $DesktopPath"
Write-Host "================================================================" -ForegroundColor Cyan

# 1. Main Interactive Control Center Shortcut
$ControlCenterLnk = Join-Path $DesktopPath "Hybrid 1.0 Control Center.lnk"
$Shortcut = $WshShell.CreateShortcut($ControlCenterLnk)
$Shortcut.TargetPath = "D:\MusicDatasets\scripts\hybrid_control_center.bat"
$Shortcut.WorkingDirectory = "D:\MusicDatasets\scripts"
$Shortcut.Description = "Interactive CLI Control Center for Hybrid 1.0 Services"
$Shortcut.IconLocation = "shell32.dll,220" # Gear / Control Panel icon
$Shortcut.Save()
Write-Host "[CREATED] Hybrid 1.0 Control Center.lnk" -ForegroundColor Green

# 2. Quick One-Click Restart Shortcut
$RestartLnk = Join-Path $DesktopPath "Restart Hybrid Daemons.lnk"
$ShortcutRestart = $WshShell.CreateShortcut($RestartLnk)
$ShortcutRestart.TargetPath = "powershell.exe"
$ShortcutRestart.Arguments = "-ExecutionPolicy Bypass -NoProfile -Command `"Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy Bypass -NoExit -File D:\MusicDatasets\scripts\manage_all_services.ps1 -Action restart'`""
$ShortcutRestart.WorkingDirectory = "D:\MusicDatasets\scripts"
$ShortcutRestart.Description = "One-click administrator restart for all 6 Hybrid daemons"
$ShortcutRestart.IconLocation = "shell32.dll,238" # Reload/Refresh loop icon
$ShortcutRestart.Save()
Write-Host "[CREATED] Restart Hybrid Daemons.lnk" -ForegroundColor Green

# 3. Live Log Streamer Shortcut
$LogsLnk = Join-Path $DesktopPath "Tail Hybrid Logs.lnk"
$ShortcutLogs = $WshShell.CreateShortcut($LogsLnk)
$ShortcutLogs.TargetPath = "powershell.exe"
$ShortcutLogs.Arguments = "-ExecutionPolicy Bypass -NoProfile -NoExit -File `"D:\MusicDatasets\scripts\tail_logs.ps1`" -Service all"
$ShortcutLogs.WorkingDirectory = "D:\MusicDatasets\scripts"
$ShortcutLogs.Description = "Real-time log streaming for all workstation daemons"
$ShortcutLogs.IconLocation = "shell32.dll,130" # Notepad/Log icon
$ShortcutLogs.Save()
Write-Host "[CREATED] Tail Hybrid Logs.lnk" -ForegroundColor Green

# 4. Pipeline Diagnostic Readiness Shortcut
$HealthLnk = Join-Path $DesktopPath "Run Pipeline Diagnostics.lnk"
$ShortcutHealth = $WshShell.CreateShortcut($HealthLnk)
$ShortcutHealth.TargetPath = "powershell.exe"
$ShortcutHealth.Arguments = "-ExecutionPolicy Bypass -NoProfile -NoExit -File `"D:\MusicDatasets\scripts\verify_pipeline_health.ps1`""
$ShortcutHealth.WorkingDirectory = "D:\MusicDatasets\scripts"
$ShortcutHealth.Description = "Full hardware, network port, and cloud connectivity diagnostic check"
$ShortcutHealth.IconLocation = "shell32.dll,301" # Shield / Verification check icon
$ShortcutHealth.Save()
Write-Host "[CREATED] Run Pipeline Diagnostics.lnk" -ForegroundColor Green

Write-Host "`nAll desktop management shortcuts successfully generated on the Desktop." -ForegroundColor Cyan
