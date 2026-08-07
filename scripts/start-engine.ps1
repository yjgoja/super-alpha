# Super Alpha realtime engine supervisor
# - Reloads .env every restart (fixes stale Neon URL after DB migration)
# - Auto-restarts on crash / fatal DB exit
# - Single primary engine (kills stale tick-direct before start)
# - WATCHDOG: kills a hung engine whose heartbeat went stale.
#   Without this the supervisor blocked forever on an `npx` that stayed alive
#   after its child died (2026-08-07: 3h50m silent outage on 26 live accounts).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

# Engine tick budget is ENGINE_BUDGET_MS (default 600000 = 10min), so a healthy
# tick can legitimately be slow. Stay well above it to avoid killing slow-but-alive
# ticks; this still catches a real hang within ~15 minutes instead of never.
$StaleLimitSec = [int]($env:ENGINE_WATCHDOG_STALE_SEC | ForEach-Object { if ($_) { $_ } else { 900 } })
$StartGraceSec = [int]($env:ENGINE_WATCHDOG_GRACE_SEC | ForEach-Object { if ($_) { $_ } else { 180 } })
$PollSec = 15
$HeartbeatPath = Join-Path $PSScriptRoot "out\engine-heartbeat.json"

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

function Stop-Tree([int]$treePid) {
  # Engine runs as npx -> cmd -> tsx -> node. Stop-Process only kills the root,
  # orphaning the node that actually holds the MetaAPI connections.
  & taskkill.exe /PID $treePid /T /F *> $null
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
      Stop-Tree $_.ProcessId
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  $pidFile = Join-Path $PSScriptRoot "out\engine.pid"
  if (Test-Path $pidFile) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

function Get-HeartbeatAgeSec {
  if (-not (Test-Path $HeartbeatPath)) { return $null }
  try {
    return ((Get-Date) - (Get-Item $HeartbeatPath).LastWriteTime).TotalSeconds
  } catch {
    return $null
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

Write-Host "Super Alpha DIRECT engine supervisor (auto-restart + watchdog)"
Write-Host "DB host allowlist: $($env:ENGINE_DB_HOST_ALLOW)"
Write-Host "Watchdog: heartbeat stale > ${StaleLimitSec}s (grace ${StartGraceSec}s) -> force restart"

$failStreak = 0
while ($true) {
  Import-DotEnv
  if (-not $env:ENGINE_DB_HOST_ALLOW) { $env:ENGINE_DB_HOST_ALLOW = "render.com" }
  $env:ENGINE_INTERVAL_MS = "2000"
  $env:ENGINE_MODE = "direct"
  $env:ENGINE_BUDGET_MS = "600000"

  Stop-StaleEngines
  Start-Sleep -Seconds 1

  # Drop the previous heartbeat so a stale file can't fool the watchdog into
  # thinking a freshly started engine is already healthy (or already hung).
  if (Test-Path $HeartbeatPath) {
    Remove-Item $HeartbeatPath -Force -ErrorAction SilentlyContinue
  }

  Write-Host "[supervisor] $(Get-Date -Format o) starting engine..."
  $code = 1
  $killedByWatchdog = $false
  try {
    $proc = Start-Process -FilePath "cmd.exe" `
      -ArgumentList "/c npx tsx --env-file=.env scripts/tick-direct.ts" `
      -NoNewWindow -PassThru
    $startedAt = Get-Date

    while ($true) {
      if ($proc.HasExited) { break }
      Start-Sleep -Seconds $PollSec

      $elapsed = ((Get-Date) - $startedAt).TotalSeconds
      if ($elapsed -lt $StartGraceSec) { continue }

      $age = Get-HeartbeatAgeSec
      $stale = ($null -eq $age) -or ($age -gt $StaleLimitSec)
      if ($stale) {
        $shown = if ($null -eq $age) { "none" } else { "$([int]$age)s" }
        Write-Host "[supervisor] WATCHDOG heartbeat=$shown > ${StaleLimitSec}s — force restart"
        Stop-Tree $proc.Id
        $killedByWatchdog = $true
        break
      }
    }

    if ($proc.HasExited) { $code = $proc.ExitCode } else { $code = 1 }
  } catch {
    $code = 1
    Write-Host "[supervisor] launch error: $_"
  }

  if ($null -eq $code) { $code = 1 }
  $failStreak++
  $backoff = [Math]::Min(30, 2 + $failStreak)
  $why = if ($killedByWatchdog) { "watchdog-kill" } else { "exit code=$code" }
  Write-Host "[supervisor] engine stopped ($why) — restart in ${backoff}s (streak=$failStreak)"
  if ($code -eq 0 -and -not $killedByWatchdog) { $failStreak = 0; $backoff = 2 }
  Start-Sleep -Seconds $backoff
}
