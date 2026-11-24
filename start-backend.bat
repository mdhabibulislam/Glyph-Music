@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Glyph Music backend

if not exist "backend\.venv\Scripts\python.exe" (
  echo   The backend isn't installed yet. Run setup.bat first.
  pause
  exit /b 1
)
if not exist ".env" (
  echo   No .env file found. Run setup.bat first.
  pause
  exit /b 1
)

echo   Glyph Music backend - http://127.0.0.1:8787  ^(Ctrl+C to stop^)
"backend\.venv\Scripts\python.exe" "backend\run.py"
if errorlevel 1 pause
