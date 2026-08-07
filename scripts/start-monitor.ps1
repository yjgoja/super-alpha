# Super Alpha monitor supervisor (local, always-on)
#
# Reads the DB and alerts to Telegram. Never touches the trading path.
# Added 2026-08-08 after a broker/DB lot divergence grew to 3x unnoticed.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless there is a BOM, and UTF-8 Korean here breaks string parsing.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$LogDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$LogFile = Join-Path $LogDir "monitor-supervisor.log"

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

$failStreak = 0
while ($true) {
  Write-Log "[monitor] starting watch loop..."

  $cmdArgs = "/c npx tsx --env-file=.env scripts/monitor-alert.ts --loop"
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList $cmdArgs -NoNewWindow -PassThru
  $proc.WaitForExit()
  $code = $proc.ExitCode

  $failStreak++
  $backoff = [Math]::Min(300, 30 + $failStreak * 30)
  if ($code -eq 0) { $failStreak = 0; $backoff = 30 }
  Write-Log "[monitor] exited code=$code - restart in ${backoff}s (streak=$failStreak)"
  Start-Sleep -Seconds $backoff
}
