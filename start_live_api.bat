@echo off
title Hybrid AI Live API (CPU)
cd /d "%~dp0"
set PYTHONPATH=%~dp0
set CUDA_VISIBLE_DEVICES=
set HYBRID_INFER_DEVICE=cpu
set HYBRID_LIVE_OUTPUT=C:\live_web_outputs
set HYBRID_SCRATCH=C:\live_web_outputs\scratch
set CORPUS_INDEX_LIVE=C:\live_web_outputs\db\corpus_index_live.sqlite
set CORPUS_INDEX_DB=C:\live_web_outputs\db\corpus_index_live.sqlite
set OMP_NUM_THREADS=2
set MKL_NUM_THREADS=2
echo Live API on 127.0.0.1:8880 — CPU only, uvicorn --reload
echo Production weights: models\release\stem_classifier_v1.0.0.pt
echo Web writes: C:\live_web_outputs  (never C:\staging_slices)
echo Trainer keeps the MX450. Ctrl+C stops this window only.
echo.
"%LocalAppData%\Programs\Python\Python312\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8880 --reload
if errorlevel 1 pause
