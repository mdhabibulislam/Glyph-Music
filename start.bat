@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Glyph Music

if not exist "backend\.venv\Scripts\python.exe" goto :needsetup
if not exist "node_modules\next" goto :needsetup
if not exist ".env" goto :needsetup

echo.
echo   Starting Glyph Music...
echo.

rem Backend in its own window.
start "Glyph Music backend" cmd /k "%~dp0start-backend.bat"

rem Build the website once if it hasn't been built yet.
if not exist ".next\BUILD_ID" (
  echo   Building the website ^(first run only^)...
  call npm run build
  if errorlevel 1 (
    echo   The build failed. See the messages above.
    pause
    exit /b 1
  )
)

rem Open the browser shortly after the server comes up.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000"

echo   Glyph Music is running at http://localhost:3000
echo   Close this window ^(and the backend window^) to stop it.
echo.
call npm run start
exit /b 0

:needsetup
echo.
echo   Glyph Music isn't set up yet. Run setup.bat first.
echo.
pause
exit /b 1
