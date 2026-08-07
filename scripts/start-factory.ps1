# Super Alpha logic-factory supervisor (local, always-on)
#
# Why local: render.yaml defines worker `super-alpha-logic-factory`, but that
# service was never created on Render (deploy fails with "service not found"),
# so the "primary unattended factory" has never actually run. Until that paid
# worker exists, this keeps discovery running on the PC -- it has DATABASE_URL,
# so epochs persist to LogicFactoryRun.
#
# SAFETY: runs with --dry-promote. The factory discovers and ranks, but never
# pushes a logic onto live accounts on its own. Promotion stays a human decision.
# To allow auto-promotion, set FACTORY_ALLOW_PROMOTE=1 in the environment.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless there is a BOM, and UTF-8 Korean here breaks string parsing.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$LogDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$LogFile = Join-Path $LogDir "factory-supervisor.log"

function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding utf8
}

function Import-DotEnv {
  if (-not (Test-Path .env)) { throw "Missing .env" }
  Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $i = $_.IndexOf('=')
    if ($i -lt 1) { return }
    $k = $_.Substring(0, $i).Trim()
    $v = $_.Substring($i + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($k, $v, "Process")
  }
}

Import-DotEnv

$promoteArg = "--dry-promote"
if ($env:FACTORY_ALLOW_PROMOTE -eq "1") {
  $promoteArg = ""
  Write-Log "[factory] AUTO-PROMOTE ENABLED - discovered logic will reach live accounts"
} else {
  Write-Log "[factory] dry-promote mode - discovery only, no live account changes"
}

$failStreak = 0
while ($true) {
  Import-DotEnv
  Write-Log "[factory] starting continuous run..."

  $cmdArgs = "/c npx tsx --env-file=.env scripts/logic-factory-run.ts --continuous --n 24 --sleep-ms 15000 $promoteArg"
  $proc = Start-Process -FilePath "cmd.exe" -ArgumentList $cmdArgs -NoNewWindow -PassThru
  $proc.WaitForExit()
  $code = $proc.ExitCode

  $failStreak++
  $backoff = [Math]::Min(120, 10 + $failStreak * 10)
  if ($code -eq 0) { $failStreak = 0; $backoff = 10 }
  Write-Log "[factory] exited code=$code - restart in ${backoff}s (streak=$failStreak)"
  Start-Sleep -Seconds $backoff
}
