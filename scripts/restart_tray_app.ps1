# D:\MusicDatasets\scripts\restart_tray_app.ps1
$ErrorActionPreference = "SilentlyContinue"

# 1. Terminate any running instances of hybrid_tray_app.py specifically
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*hybrid_tray_app.py*" } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "[TERMINATED] Closed existing tray process (PID: $($_.ProcessId))" -ForegroundColor Yellow
    }

Start-Sleep -Milliseconds 500

# 2. Locate pythonw.exe via the resolver.
#    Get-Command pythonw.exe resolves to the WindowsApps alias stub on this
#    machine, and deriving it from Get-Command python.exe yields another stub -
#    either way the tray silently never appears.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\resolve_python.ps1"
$Python = Assert-HybridPython

$PythonW = $Python -replace "python\.exe$", "pythonw.exe"
if (-not (Test-Path $PythonW)) {
    Write-Host "[WARN] pythonw.exe not found beside $Python; using python.exe (console window will stay open)." -ForegroundColor Yellow
    $PythonW = $Python
}

# 3. Launch the tray app detached in the background
$ScriptPath = Join-Path $PSScriptRoot "hybrid_tray_app.py"
$WorkDir = $PSScriptRoot

if (-not (Test-Path $ScriptPath)) {
    Write-Host "[ERROR] $ScriptPath not found." -ForegroundColor Red
    exit 1
}

Start-Process -FilePath $PythonW -ArgumentList "`"$ScriptPath`"" -WorkingDirectory $WorkDir

Write-Host "[SUCCESS] Hybrid 1.0 System Tray App restarted in background." -ForegroundColor Green
Write-Host "  Interpreter: $PythonW" -ForegroundColor Gray
