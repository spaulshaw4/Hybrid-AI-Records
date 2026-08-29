:: D:\MusicDatasets\scripts\hybrid_control_center.bat
@echo off
setlocal EnableDelayedExpansion
title Hybrid 1.0 - Workstation Control Center

:: Enforce administrator privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ELEVATING] Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "D:\MusicDatasets\scripts"

:MENU
cls
color 0B
echo ================================================================
echo           HYBRID 1.0 - WORKSTATION CONTROL CENTER
echo ================================================================
echo.
echo   [1] View Service Status Matrix
echo   [2] Restart All 6 Services (Clean Reset)
echo   [3] Start All Services
echo   [4] Stop All Services (Safe Reverse Order)
echo   [5] Run Full Health ^& Readiness Diagnostics
echo   [6] Stream All Live Service Logs (Tail)
echo   [7] Trigger End-to-End Test Pipeline Run
echo   [8] Open Prometheus Web UI (Port 9090)
echo   [9] Open Telemetry Dashboard (/telemetry)
echo   [0] Exit
echo.
echo ================================================================
set /p choice="Select an action [0-9]: "

if "%choice%"=="1" goto STATUS
if "%choice%"=="2" goto RESTART
if "%choice%"=="3" goto START_ALL
if "%choice%"=="4" goto STOP_ALL
if "%choice%"=="5" goto DIAGNOSTICS
if "%choice%"=="6" goto TAIL_LOGS
if "%choice%"=="7" goto TEST_PIPELINE
if "%choice%"=="8" goto PROMETHEUS_UI
if "%choice%"=="9" goto DASHBOARD_UI
if "%choice%"=="0" exit /b
goto MENU

:STATUS
cls
powershell -ExecutionPolicy Bypass -File "D:\MusicDatasets\scripts\manage_all_services.ps1" -Action status
echo.
pause
goto MENU

:RESTART
cls
powershell -ExecutionPolicy Bypass -File "D:\MusicDatasets\scripts\manage_all_services.ps1" -Action restart
echo.
pause
goto MENU

:START_ALL
cls
powershell -ExecutionPolicy Bypass -File "D:\MusicDatasets\scripts\manage_all_services.ps1" -Action start
echo.
pause
goto MENU

:STOP_ALL
cls
powershell -ExecutionPolicy Bypass -File "D:\MusicDatasets\scripts\manage_all_services.ps1" -Action stop
echo.
pause
goto MENU

:DIAGNOSTICS
cls
powershell -ExecutionPolicy Bypass -File "D:\MusicDatasets\scripts\verify_pipeline_health.ps1"
echo.
pause
goto MENU

:TAIL_LOGS
cls
echo Streaming live logs. Press Ctrl+C to stop streaming...
powershell -ExecutionPolicy Bypass -File "D:\MusicDatasets\scripts\tail_logs.ps1" -Service all
goto MENU

:TEST_PIPELINE
cls
:: Resolved through resolve_python.ps1 rather than bare `python`, which on this
:: machine resolves to the Microsoft Store alias stub and is not an interpreter.
powershell -ExecutionPolicy Bypass -Command ". 'D:\MusicDatasets\scripts\resolve_python.ps1'; $py = Assert-HybridPython; & $py 'D:\MusicDatasets\scripts\test_pipeline_trigger.py'"
echo.
pause
goto MENU

:PROMETHEUS_UI
start http://localhost:9090
goto MENU

:DASHBOARD_UI
start http://localhost:3000/telemetry
goto MENU
