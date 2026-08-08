# Super Alpha factory notifications (local, always-on)
#
# Two loops the old scripts/lab/ system used to provide and that vanished with it:
#   - factory-daily-report : full ranking report, once a day (default midnight KST)
#   - factory-notify       : new all-time record alert, as it happens
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless there is a BOM, and UTF-8 Korean here breaks string parsing.
#
# No console windows: ProcessStartInfo with CreateNoWindow + UseShellExecute=$false,
# and node/tsx called directly instead of npx (which spawns a visible cmd.exe).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$LogDir = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$LogFile = Join-Path $LogDir "factory-notify-supervisor.log"
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
  return [System.Diagnostics.Process]::Start($psi)
}

$jobs = @(
  @{ Name = "daily-report"; Args = "scripts/factory-daily-report.ts --loop"; Proc = $null },
  @{ Name = "record-alert"; Args = "scripts/factory-notify.ts --loop"; Proc = $null }
)

Write-Log "[factory-notify] supervisor start"

while ($true) {
  foreach ($j in $jobs) {
    if ($null -eq $j.Proc -or $j.Proc.HasExited) {
      if ($null -ne $j.Proc) {
        Write-Log "[$($j.Name)] exited code=$($j.Proc.ExitCode) - restarting"
      }
      $j.Proc = Start-Hidden $j.Args
      Write-Log "[$($j.Name)] started pid=$($j.Proc.Id)"
    }
  }
  # Both children are --loop and should never exit. Poll slowly so a crash
  # loop cannot spam restarts.
  Start-Sleep -Seconds 300
}
