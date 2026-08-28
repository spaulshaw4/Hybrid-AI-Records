@echo off
cd /d D:\MusicDatasets
call venv\Scripts\activate
python scripts\worker_daemon.py
pause
