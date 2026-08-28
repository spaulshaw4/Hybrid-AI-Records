@echo off
TITLE Hybrid 1.0 Alpha - Master Environment Launcher
color 0A

echo ==============================================================================
echo LAUNCHING HYBRID 1.0 ALPHA ENVIRONMENT (DAEMON + FRONTEND)
echo ==============================================================================

:: 1. Launch Python Worker Daemon in a separate new window
echo [1/2] Starting Hybrid 1.0 Background Worker Daemon...
start "Hybrid Worker Daemon" cmd /k "python D:\MusicDatasets\scripts\master_daemon_pipeline.py"

:: 2. Launch Next.js Management Frontend in a separate new window
echo [2/2] Starting Next.js Management Frontend...
cd /d "D:\MusicDatasets"

if exist "package.json" (
    start "Hybrid Frontend (Next.js)" cmd /k "npm run dev"
) else (
    echo [WARNING] package.json not found in D:\MusicDatasets. Skipping frontend launch.
)

echo ==============================================================================
echo [SUCCESS] Master startup sequence complete.
echo Worker Daemon and Frontend instances are running in independent terminal windows.
echo ==============================================================================
pause
