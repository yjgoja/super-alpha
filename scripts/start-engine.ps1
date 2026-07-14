# Super Alpha realtime engine launcher (2s ticks)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

if (-not (Test-Path .env)) { throw "Missing .env" }

Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  $i = $_.IndexOf('=')
  if ($i -lt 1) { return }
  $k = $_.Substring(0, $i).Trim()
  $v = $_.Substring($i + 1).Trim().Trim('"').Trim("'")
  [Environment]::SetEnvironmentVariable($k, $v, "Process")
}

$env:ENGINE_INTERVAL_MS = "2000"
Write-Host "Super Alpha realtime engine starting..."
npx tsx scripts/tick-loop.ts
