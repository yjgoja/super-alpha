# Super Alpha logic-factory supervisor (local, always-on)
#
# The factory runs on this PC only. render.yaml defines a worker but that
# service was never created, so this is the real thing.
#
# SAFETY: runs with --dry-promote. The factory discovers and ranks, but never
# pushes a logic onto live accounts on its own. Promotion stays a human decision.
# To allow auto-promotion, set FACTORY_ALLOW_PROMOTE=1 in the environment.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless there is a BOM, and UTF-8 Korean here breaks string parsing.
#
# Windows flashing: Start-Process -NoNewWindow still allocates a console for
# cmd.exe, so a window blinked on every (re)start and interrupted the desktop.
# ProcessStartInfo with CreateNoWindow + UseShellExecute=$false is genuinely
# invisible. We also call node/tsx directly instead of `npx` so there is one
# child process instead of the npx -> cmd -> tsx -> node chain.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$LogDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$LogFile = Join-Path $LogDir "factory-supervisor.log"
$Tsx = Join-Path (Get-Location) "node_modules\tsx\dist\cli.mjs"

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

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

$promoteArg = "--dry-promote"
if ($env:FACTORY_ALLOW_PROMOTE -eq "1") {
  $promoteArg = ""
  Write-Log "[factory] AUTO-PROMOTE ENABLED - discovered logic will reach live accounts"
} else {
  Write-Log "[factory] dry-promote mode - discovery only, no live account changes"
}

$failStreak = 0
while ($true) {
  Write-Log "[factory] starting continuous run..."

  $proc = Start-Hidden "scripts/logic-factory-run.ts --continuous --n 24 --sleep-ms 15000 $promoteArg"
  $out = $proc.StandardOutput.ReadToEnd()
  $err = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  $code = $proc.ExitCode
  if ($out) { Add-Content -Path $LogFile -Value $out -Encoding utf8 }
  if ($err) { Add-Content -Path $LogFile -Value $err -Encoding utf8 }

  $failStreak++
  # --continuous should never return. Back off hard so a crash-looping child
  # cannot spam restarts (or windows).
  $backoff = [Math]::Min(1800, 300 * $failStreak)
  if ($code -eq 0) { $failStreak = 0; $backoff = 300 }
  Write-Log "[factory] exited code=$code - restart in ${backoff}s (streak=$failStreak)"
  Start-Sleep -Seconds $backoff
}
