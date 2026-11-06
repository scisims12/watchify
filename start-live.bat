@echo off
title Watch Party (live)
cd /d "%~dp0"

where node >nul 2>nul || (echo Node.js not found. Install it from https://nodejs.org and run this again. & pause & exit /b)
where cloudflared >nul 2>nul || (echo cloudflared not found. Open a terminal and run: winget install --id Cloudflare.cloudflared & echo Then close it, reopen, and run this file again. & pause & exit /b)

if not exist node_modules call npm install

rem Cloudflare free plan blocks uploads above 100 MB, so keep the app limit just under it
set MAX_MB=90

start "Watch Party server (keep open)" cmd /k node server.js
timeout /t 3 >nul

echo.
echo  Look for the line with https://something.trycloudflare.com below.
echo  Send that link to your friends. Keep this window and the server window open.
echo.
cloudflared tunnel --url http://localhost:3000
pause
