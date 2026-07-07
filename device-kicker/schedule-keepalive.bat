@echo off
REM schedule-keepalive.bat — Windows Task Scheduler runner
REM Jalankan keep-alive.js dan log output

cd /d "%~dp0"
echo [%date% %time%] Keep-Alive Start >> keepalive.log
node keep-alive.js >> keepalive.log 2>&1
echo [%date% %time%] Keep-Alive End >> keepalive.log
echo. >> keepalive.log
