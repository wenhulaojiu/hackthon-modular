@echo off
chcp 65001 >nul
set KEXU_LOCAL_PORT=5183
cd /d "%~dp0"
node scripts/local-wechat/launch.mjs
pause
