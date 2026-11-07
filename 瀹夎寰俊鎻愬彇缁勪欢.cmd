@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 or later, then run this file again.
  pause
  exit /b 1
)
node "scripts\local-wechat\setup.mjs"
if errorlevel 1 (
  pause
  exit /b 1
)
echo Component preparation finished. No WeChat data was read.
pause
