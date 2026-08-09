@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS first: https://nodejs.org/
  pause
  exit /b 1
)
call npm install
if errorlevel 1 pause & exit /b 1
call npm start
