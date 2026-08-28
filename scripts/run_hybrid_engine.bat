@echo off
TITLE Hybrid 1.0 - Automated Engine Run
color 0A

echo ==============================================================================
echo INITIATING HYBRID 2-PHASE SPLICER AND TRANSFER ENGINE
echo ==============================================================================

:: Load Credentials
set SUPABASE_URL=your_project_url_here
set SUPABASE_SERVICE_ROLE_KEY=your_service_key_here

:: Define Paths
set LOG_DIR=D:\MusicDatasets\logs
set SCRIPT_PATH=D:\MusicDatasets\scripts\batch_slicer_upload.py

:: Ensure log directory exists
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Generate a timestamped log file
set LOG_FILE=%LOG_DIR%\engine_run_%date:~10,4%%date:~4,2%%date:~7,2%.log

echo [INFO] Routing engine output to %LOG_FILE%

:: Execute the Python script and append all output to the log file
python "%SCRIPT_PATH%" >> "%LOG_FILE%" 2>&1

:: Check for failure and trigger a native Windows desktop popup
if %errorlevel% neq 0 (
    echo [ERROR] Engine encountered a fatal error. Triggering desktop alert...
    powershell -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('The Hybrid 1.0 engine failed during the nightly run. Please check the log file: %LOG_FILE%', 'Hybrid AI Records - System Error', 'OK', 'Error')"
) else (
    echo [SUCCESS] Engine execution completed flawlessly.
)

echo ==============================================================================
