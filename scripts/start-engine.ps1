# Super Alpha realtime engine supervisor
# - Reloads .env every restart (fixes stale Neon URL after DB migration)
# - Auto-restarts on crash / fatal DB exit
# - Single primary engine (kills stale tick-direct before start)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

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

function Stop-StaleEngines {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and
      ($_.CommandLine -match 'tick-direct\.ts' -or $_.CommandLine -match 'scripts\\tick-direct') -and
      $_.ProcessId -ne $PID
    } |
    ForEach-Object {
      Write-Host "[supervisor] kill stale engine pid=$($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  $pidFile = Join-Path $PSScriptRoot "out\engine.pid"
  if (Test-Path $pidFile) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

# Default: require Render (or set ENGINE_DB_HOST_ALLOW in .env)
Import-DotEnv
if (-not $env:ENGINE_DB_HOST_ALLOW) {
  $env:ENGINE_DB_HOST_ALLOW = "render.com"
}
$env:ENGINE_INTERVAL_MS = "2000"
$env:ENGINE_MODE = "direct"
$env:ENGINE_BUDGET_MS = "600000"

Write-Host "Super Alpha DIRECT engine supervisor (auto-restart, 2s ticks)"
Write-Host "DB host allowlist: $($env:ENGINE_DB_HOST_ALLOW)"

$failStreak = 0
while ($true) {
  Import-DotEnv
  if (-not $env:ENGINE_DB_HOST_ALLOW) { $env:ENGINE_DB_HOST_ALLOW = "render.com" }
  $env:ENGINE_INTERVAL_MS = "2000"
  $env:ENGINE_MODE = "direct"
  $env:ENGINE_BUDGET_MS = "600000"

  Stop-StaleEngines
  Start-Sleep -Seconds 1

  Write-Host "[supervisor] $(Get-Date -Format o) starting engine..."
  try {
    npx tsx --env-file=.env scripts/tick-direct.ts
    $code = $LASTEXITCODE
  } catch {
    $code = 1
    Write-Host "[supervisor] launch error: $_"
  }

  if ($null -eq $code) { $code = 1 }
  $failStreak++
  $backoff = [Math]::Min(30, 2 + $failStreak)
  Write-Host "[supervisor] engine exited code=$code — restart in ${backoff}s (streak=$failStreak)"
  if ($code -eq 0) { $failStreak = 0; $backoff = 2 }
  Start-Sleep -Seconds $backoff
}
