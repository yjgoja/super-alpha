# Super Alpha monitor supervisor (local, always-on)
#
# Reads the DB and alerts to Telegram. Never touches the trading path.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless there is a BOM, and UTF-8 Korean here breaks string parsing.
#
# Windows flashing: Start-Process -NoNewWindow still allocates a console for
# cmd.exe, so a window blinked on every restart and interrupted the desktop.
# ProcessStartInfo with CreateNoWindow + UseShellExecute=$false is the only
# combination that is genuinely invisible. We also call node/tsx directly
# instead of `npx` so there is one child process instead of npx -> cmd -> node.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$LogDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$LogFile = Join-Path $LogDir "monitor-supervisor.log"
$Tsx = Join-Path (Get-Location) "node_modules\tsx\dist\cli.mjs"

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

# Launch a node script with no console window at all.
function Start-Hidden([string]$scriptArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.Arguments = "--env-file=.env `"$Tsx`" $scriptArgs"
  $psi.WorkingDirectory = (Get-Location).Path
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  return [System.Diagnostics.Process]::Start($psi)
}

$failStreak = 0
while ($true) {
  Write-Log "[monitor] starting watch loop..."

  $proc = Start-Hidden "scripts/monitor-alert.ts --loop"
  $out = $proc.StandardOutput.ReadToEnd()
  $err = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  $code = $proc.ExitCode
  if ($out) { Add-Content -Path $LogFile -Value $out -Encoding utf8 }
  if ($err) { Add-Content -Path $LogFile -Value $err -Encoding utf8 }

  $failStreak++
  # --loop should never return. If it does, something is wrong; back off hard
  # so a crash-looping child cannot spam restarts (or windows) every minute.
  $backoff = [Math]::Min(1800, 300 * $failStreak)
  if ($code -eq 0) { $failStreak = 0; $backoff = 300 }
  Write-Log "[monitor] exited code=$code - restart in ${backoff}s (streak=$failStreak)"
  Start-Sleep -Seconds $backoff
}
