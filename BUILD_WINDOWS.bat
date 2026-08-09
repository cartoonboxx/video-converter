@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo Video to MP4 - Windows build
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 goto :error

echo [2/3] Building TypeScript...
call npm run build
if errorlevel 1 goto :error

echo [3/3] Creating Windows installer...
call npm run dist:win
if errorlevel 1 goto :error

echo.
echo DONE. Installer is in the release folder.
start "" "%~dp0release"
pause
exit /b 0

:error
echo.
echo Build failed. Check the error messages above.
pause
exit /b 1
