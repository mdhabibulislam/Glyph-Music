@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Glyph Music - reset access code

if not exist "backend\.venv\Scripts\python.exe" (
  echo   Run setup.bat first.
  pause
  exit /b 1
)
echo.
echo   Close the Glyph Music backend window before continuing.
"backend\.venv\Scripts\python.exe" "scripts\reset_code.py"
echo.
pause
