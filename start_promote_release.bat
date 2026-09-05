@echo off
title Hybrid AI Release Promoter
cd /d "%~dp0"
set PYTHONPATH=%~dp0
set CUDA_VISIBLE_DEVICES=
set HYBRID_INFER_DEVICE=cpu
echo Promoting finished GPU epochs onto models\release\stem_classifier_v1.0.0.pt
echo.
"%LocalAppData%\Programs\Python\Python312\python.exe" "%~dp0scripts\promote_learning_to_release.py"
if errorlevel 1 pause
