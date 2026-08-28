@echo off
TITLE Hybrid 1.0 Alpha - Register Daily Hex Audit Task
color 0A

echo ==============================================================================
echo REGISTERING HYBRID 1.0 DAILY HEX AUDIT WITH WINDOWS TASK SCHEDULER
echo ==============================================================================

:: Define Task Parameters
set TASK_NAME=HybridDailyHexAudit
set PYTHON_PATH=python
set SCRIPT_PATH=D:\MusicDatasets\scripts\hybrid_daily_hex_audit.py

:: Check if Administrator privileges are active
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Administrative privileges required. Please right-click and select "Run as administrator".
    pause
    exit /b 1
)

:: Create or update scheduled task to run daily at 2:00 AM
echo [INFO] Scheduling task "%TASK_NAME%" to run daily at 02:00 AM...
schtasks /create /tn "%TASK_NAME%" /tr "%PYTHON_PATH% \"%SCRIPT_PATH%\"" /sc DAILY /st 02:00 /f /rl HIGHEST

if %errorlevel% eq 0 (
    echo [SUCCESS] Task "%TASK_NAME%" successfully registered in Windows Task Scheduler.
    echo [INFO] Execution time set daily at 02:00 AM with highest privileges.
) else (
    echo [ERROR] Failed to register scheduled task. Check syntax and path parameters.
)

echo ==============================================================================
pause
