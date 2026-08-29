# D:\MusicDatasets\scripts\install_tray_startup.ps1
# Installs dependencies and creates a silent background startup launcher in Windows Startup

$ErrorActionPreference = "Stop"

# Resolve a real interpreter. Bare `pip` and `Get-Command python.exe` both
# resolve to the Microsoft Store alias stub on this machine, and deriving
# pythonw.exe from that path yields another stub, so the tray would never start.
. "$PSScriptRoot\resolve_python.ps1"
$PythonPath = Assert-HybridPython

$PythonWPath = $PythonPath -replace "python\.exe$", "pythonw.exe"
if (-not (Test-Path $PythonWPath)) {
    Write-Host "[WARN] pythonw.exe not found beside $PythonPath; falling back to python.exe" -ForegroundColor Yellow
    Write-Host "       (a console window will remain visible while the tray runs)" -ForegroundColor Yellow
    $PythonWPath = $PythonPath
}

Write-Host "Installing requirements (pystray, Pillow)..." -ForegroundColor Cyan
& $PythonPath -m pip install pystray pillow

if ($LASTEXITCODE -ne 0) {
    throw "Dependency install failed. The tray app needs both pystray and Pillow."
}

# Confirm the modules actually import before wiring up autostart
& $PythonPath -c "import pystray, PIL" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "pystray/Pillow installed but do not import. Not registering startup entry."
}
Write-Host "  -> Verified pystray and Pillow import cleanly." -ForegroundColor Gray

$StartupDir = [Environment]::GetFolderPath("Startup")
$TrayScript = Join-Path $PSScriptRoot "hybrid_tray_app.py"

$WshShell = New-Object -ComObject WScript.Shell
$ShortcutPath = Join-Path $StartupDir "Hybrid Tray Controller.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $PythonWPath
$Shortcut.Arguments = "`"D:\MusicDatasets\scripts\hybrid_tray_app.py`""
$Shortcut.WorkingDirectory = "D:\MusicDatasets\scripts"
$Shortcut.Description = "Hybrid 1.0 System Tray Service Monitor"
$Shortcut.IconLocation = "shell32.dll,220"
$Shortcut.Save()

Write-Host "[SUCCESS] Tray app installed to Windows Startup." -ForegroundColor Green
Write-Host "  Interpreter : $PythonWPath"
Write-Host "  Startup lnk : $ShortcutPath"
Write-Host "Launching now in background..." -ForegroundColor Green

Start-Process -FilePath $PythonWPath -ArgumentList "`"D:\MusicDatasets\scripts\hybrid_tray_app.py`"" -WorkingDirectory "D:\MusicDatasets\scripts"
