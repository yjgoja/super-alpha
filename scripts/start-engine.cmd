@echo off
REM Super Alpha realtime engine — PC 켜져 있으면 2초마다 익절/물타기/손절
cd /d "%~dp0.."
set ENGINE_INTERVAL_MS=2000
if not exist ".env" (
  echo Missing .env
  exit /b 1
)
REM load .env into environment (simple KEY=VAL lines)
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  set "line=%%a"
  if not "!line:~0,1!"=="#" if not "%%a"=="" (
    set "%%a=%%~b"
  )
)
echo Starting Super Alpha engine...
npx tsx scripts/tick-loop.ts
