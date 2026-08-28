:: scripts/install_daemon_service.bat
@echo off
TITLE Hybrid 1.0 Alpha - NSSM Service Installer
color 0A

echo ==============================================================================
echo REGISTERING HYBRID DAEMON AS A WINDOWS BACKGROUND SERVICE (NSSM)
echo ==============================================================================

:: Check if Administrator privileges are active
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Administrative privileges required. Please right-click and select "Run as administrator".
    pause
    exit /b 1
)

:: Configuration
set SERVICE_NAME=Hybrid1_Worker_Daemon
set PYTHON_PATH=python.exe
set SCRIPT_PATH=D:\MusicDatasets\scripts\master_daemon_pipeline.py
set WORK_DIR=D:\MusicDatasets\scripts
set LOG_DIR=D:\MusicDatasets\logs

:: Ensure log directory exists
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Check if NSSM is available in PATH
where nssm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] NSSM (Non-Sucking Service Manager) is not found in your system PATH.
    echo Please download NSSM, extract it, and add it to your System PATH before running this script.
    pause
    exit /b 1
)

echo [INFO] Installing %SERVICE_NAME%...
nssm install %SERVICE_NAME% "%PYTHON_PATH%" "%SCRIPT_PATH%"

echo [INFO] Configuring Service Parameters...
nssm set %SERVICE_NAME% AppDirectory "%WORK_DIR%"
nssm set %SERVICE_NAME% Description "Hybrid 1.0 Alpha - Master Audio Production Worker Daemon"
nssm set %SERVICE_NAME% Start SERVICE_AUTO_START

:: Set robust logging for the background service
nssm set %SERVICE_NAME% AppStdout "%LOG_DIR%\daemon_service.log"
nssm set %SERVICE_NAME% AppStderr "%LOG_DIR%\daemon_error.log"
nssm set %SERVICE_NAME% AppRotateFiles 1
nssm set %SERVICE_NAME% AppRotateOnline 1
nssm set %SERVICE_NAME% AppRotateBytes 10485760

:: Set auto-restart policies on crash
nssm set %SERVICE_NAME% AppExit Default Restart
nssm set %SERVICE_NAME% AppRestartDelay 5000

echo [INFO] Starting the Service...
nssm start %SERVICE_NAME%

echo ==============================================================================
echo [SUCCESS] Daemon successfully installed and running in the background.
echo Check Windows Services (services.msc) to manage it.
echo ==============================================================================
pause
