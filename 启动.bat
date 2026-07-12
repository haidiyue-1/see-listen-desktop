@echo off
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

title See-Listen-Launcher
cls
echo ====================================================
echo  [See-Listen-Desktop] Starting All Services
echo ====================================================
echo.

cd /d "%~dp0"

echo [1/3] Stopping old Node.exe processes...
taskkill /f /im node.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [2/3] Starting Node.js Server in background...
echo Set ws = CreateObject("Wscript.Shell") > run_node.vbs
echo ws.run "node server.js", 0, False >> run_node.vbs
wscript.exe run_node.vbs
timeout /t 1 /nobreak >nul
del run_node.vbs >nul 2>&1

echo [3/3] Restarting Cloudflared Service...
net stop Cloudflared >nul 2>&1
timeout /t 1 /nobreak >nul
net start Cloudflared

echo.
echo ====================================================
echo  All operations completed successfully!
echo  Open: http://localhost:3000
echo ====================================================
echo.
pause
