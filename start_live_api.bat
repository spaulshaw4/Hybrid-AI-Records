@echo off
title Hybrid AI Live API (CPU)
cd /d "%~dp0"
set PYTHONPATH=%~dp0
set CUDA_VISIBLE_DEVICES=
set HYBRID_INFER_DEVICE=cpu
set OMP_NUM_THREADS=2
set MKL_NUM_THREADS=2
echo Live API on 127.0.0.1:8000 — CPU only, 2 workers.
echo Production weights: models\release\stem_classifier_v1.0.0.pt
echo Trainer keeps the MX450. Ctrl+C stops this window only.
echo.
"%LocalAppData%\Programs\Python\Python312\python.exe" "%~dp0api\headless_job_runner.py" --host 127.0.0.1 --port 8000 --workers 2 -d cpu
if errorlevel 1 pause
