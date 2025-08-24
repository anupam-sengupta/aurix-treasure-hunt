@echo off
echo Stopping any running Node.js processes...
taskkill /IM node.exe /F >nul 2>&1

echo Starting backend with nohup equivalent...
cd /d %~dp0
start "" /B node src\server.js

echo Backend restarted successfully.

