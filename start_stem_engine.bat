@echo off
title Hybrid AI Neural Audio Engine v1.0.0
cd /d "%~dp0"
set PYTHONPATH=%~dp0
set PYTHONIOENCODING=utf-8
chcp 65001 >nul
echo Hybrid AI Neural Audio Engine v1.0.0
echo Live meter on CPU using models\release\stem_classifier_v1.0.0.pt
echo Trainer keeps the MX450. Ctrl+C stops this window only.
echo.
"%LocalAppData%\Programs\Python\Python312\python.exe" "%~dp0engine\live_audio_monitor.py" --infer-device cpu %*
if errorlevel 1 pause
