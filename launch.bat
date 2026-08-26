@echo off
taskkill /F /IM electron.exe >nul 2>&1
cd /d "C:\Users\GH\Desktop\NileVault"
set USERDATA=C:\Users\GH\AppData\Local\Temp\nilevault-dev
if not exist "%USERDATA%" mkdir "%USERDATA%"
"node_modules\electron\dist\electron.exe" --no-sandbox . --user-data-dir="%USERDATA%"
