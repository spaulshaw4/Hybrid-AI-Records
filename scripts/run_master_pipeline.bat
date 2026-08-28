@echo off
TITLE Hybrid 1.0 - Master Generation Pipeline
color 0A

:: -----------------------------------------------------------------------------
:: MASTER PIPELINE EXECUTION SCRIPT
:: Ties together: Orchestrator -> Bus Summation -> Hex Hook -> Stem Purging
:: -----------------------------------------------------------------------------

set SUPABASE_URL=your_project_url_here
set SUPABASE_SERVICE_ROLE_KEY=your_service_key_here

:: Accept Session ID as command line argument or prompt if missing
set SESSION_ID=%1
if "%SESSION_ID%"=="" (
    set /p SESSION_ID="Enter Session ID: "
)

set WORK_DIR=D:\MusicDatasets\renders\%SESSION_ID%
set SCRIPT_DIR=D:\MusicDatasets\scripts

echo ==============================================================================
echo [PIPELINE START] Session: %SESSION_ID%
echo ==============================================================================

:: Step 1: Run Orchestrator (Fetches seed stems & triggers feeder bot if needed)
echo [1/4] Running Cylinder Orchestrator...
python "%SCRIPT_DIR%\cylinder_orchestrator.py" --session "%SESSION_ID%"
if %errorlevel% neq 0 goto :error

:: Step 2: Run Bus Summation (Merges stems into 7-minute master track)
echo [2/4] Running Bus Summation Engine...
python "%SCRIPT_DIR%\cylinder_bus_summation.py" --session "%SESSION_ID%" --dir "%WORK_DIR%"
if %errorlevel% neq 0 goto :error

:: Step 3: Run Cryptographic Hex Hook (Hashes master and locks Supabase vault)
echo [3/4] Executing Hex Pipeline Hook...
python "%SCRIPT_DIR%\hybrid_hex_pipeline_hook.py" --session "%SESSION_ID%" --dir "%WORK_DIR%"
if %errorlevel% neq 0 goto :error

:: Step 4: Purge Temporary Stems (Protects network egress by wiping local cache)
echo [4/4] Purging temporary stems to protect cloud egress...
if exist "%WORK_DIR%\raw_stems" (
    rmdir /s /q "%WORK_DIR%\raw_stems"
    echo [EGRESS PROTECT] Temporary raw stems wiped successfully.
)

echo ==============================================================================
echo [SUCCESS] Master pipeline execution completed flawlessly for session: %SESSION_ID%
echo ==============================================================================
goto :eof

:error
echo ==============================================================================
echo [CRITICAL ERROR] Pipeline failed during execution. Check logs above.
echo ==============================================================================
exit /b 1
