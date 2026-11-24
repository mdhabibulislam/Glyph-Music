@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Glyph Music setup

echo.
echo   Glyph Music - setup
echo   -------------------
echo.

rem ---- Node.js ---------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js 20 or newer is required.
  echo   Install it from https://nodejs.org and run setup.bat again.
  goto :fail
)

rem ---- Python ----------------------------------------------------------------
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  where winget >nul 2>nul
  if not errorlevel 1 (
    echo   Python was not found. Installing Python 3.12 with winget...
    winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
    echo.
    echo   Python was installed. Close this window and run setup.bat again.
    goto :fail
  )
  echo   Python 3.10 or newer is required.
  echo   Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^)
  echo   and run setup.bat again.
  goto :fail
)

rem ---- Backend ---------------------------------------------------------------
echo   [1/4] Creating the Python environment...
if not exist "backend\.venv\Scripts\python.exe" (
  %PY% -m venv "backend\.venv"
  if errorlevel 1 (
    echo.
    echo   Could not create the Python environment. If this folder's path is very
    echo   long, move the project somewhere shorter ^(for example C:\GlyphMusic^).
    goto :fail
  )
)
echo   [2/4] Installing backend packages ^(FastAPI, FFmpeg, Mutagen, RapidFuzz^)...
"backend\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r "backend\requirements.txt"
if errorlevel 1 goto :fail

rem ---- Frontend --------------------------------------------------------------
echo   [3/4] Installing frontend packages...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

rem ---- Secrets ---------------------------------------------------------------
echo   [4/4] Creating your private configuration...
"backend\.venv\Scripts\python.exe" "scripts\init_env.py"
if errorlevel 1 goto :fail

echo.
echo   Building the website...
call npm run build
if errorlevel 1 goto :fail

echo.
echo   Setup complete. Double-click start.bat to launch Glyph Music.
echo   The first time the website opens, it asks you to create your access code.
echo.
pause
exit /b 0

:fail
echo.
echo   Setup did not finish. Fix the problem above and run setup.bat again.
echo.
pause
exit /b 1
