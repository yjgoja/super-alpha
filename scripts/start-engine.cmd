@echo off
REM Super Alpha realtime engine supervisor (direct MetaAPI, auto-restart)
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-engine.ps1"
