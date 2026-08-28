@echo off
TITLE Hybrid 1.0 Alpha - Automated Deployment & Initialization
color 0A

echo ==============================================================================
echo HYBRID 1.0 ALPHA - AUTOMATED DEPLOYMENT & ENVIRONMENT SETUP
echo ==============================================================================

:: 1. Initialize Required Directories
echo [1/4] Initializing local dataset and processing directories...
if not exist "D:\MusicDatasets\job_payloads" mkdir "D:\MusicDatasets\job_payloads"
if not exist "D:\MusicDatasets\renders" mkdir "D:\MusicDatasets\renders"
if not exist "D:\MusicDatasets\samples" mkdir "D:\MusicDatasets\samples"
if not exist "D:\MusicDatasets\verification_cache" mkdir "D:\MusicDatasets\verification_cache"
if not exist "D:\MusicDatasets\logs" mkdir "D:\MusicDatasets\logs"
echo [OK] Directory structure verified at D:\MusicDatasets\

:: 2. Verify Python and Required Packages
echo [2/4] Verifying Python runtime and core audio/database packages...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed or not in system PATH.
    pause
    exit /b 1
)

python -c "import numpy, soundfile, librosa, supabase, psutil" >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Missing required Python packages. Installing dependencies...
    pip install numpy soundfile librosa supabase psutil
) else (
    echo [OK] All Python dependencies verified.
)

:: 3. Run System Diagnostic
echo [3/4] Executing system diagnostic check...
if exist "D:\MusicDatasets\scripts\hybrid_system_status_check.py" (
    python "D:\MusicDatasets\scripts\hybrid_system_status_check.py"
) else (
    echo [INFO] System status check script not found in scripts directory. Skipping diagnostic.
)

:: 4. Service Startup Options
echo [4/4] Deployment preparation complete.
echo ==============================================================================
echo To start the worker pipeline daemon manually, run:
echo python D:\MusicDatasets\scripts\master_daemon_pipeline.py
echo.
echo To start via NSSM Windows Service (if installed), run:
echo nssm start HybridWorkerDaemon
echo ==============================================================================
pause
