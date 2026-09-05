@echo off
title Hybrid AI Neural Audio Engine CLI
cd /d "%~dp0"
set PYTHONPATH=%~dp0
set PYTHONIOENCODING=utf-8
if "%~1"=="" (
  echo Usage: start_stem_cli.bat "C:\Path\To\Stems"
  echo Example: start_stem_cli.bat "C:\staging_slices\001 - ANiMAL - Clinic A"
  pause
  exit /b 1
)
"%LocalAppData%\Programs\Python\Python312\python.exe" "%~dp0cli.py" -i %* -d cpu
pause
