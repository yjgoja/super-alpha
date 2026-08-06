# 매일 00:00에 schedule 워커가 떠 있도록(부팅 시 자동 기동) 등록
# 실제 발행은 schedule 루프가 config.yaml 의 post_times=00:00 에 4건 실행

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"
$Main = Join-Path $Root "main.py"
$TaskName = "NaverBlogSEO-MidnightSchedule"

if (-not (Test-Path $Python)) {
    throw "venv python 없음: $Python"
}

$Action = New-ScheduledTaskAction `
    -Execute $Python `
    -Argument "`"$Main`" schedule" `
    -WorkingDirectory $Root

# 로그인 시 시작 + 매일 자정에도 깨움(이미 떠 있으면 중복 방지용으로 워커가 돌고 있어야 함)
$Triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn),
    (New-ScheduledTaskTrigger -Daily -At "00:00")
)

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Triggers `
    -Settings $Settings `
    -Description "네이버 블로그 SEO: 매일 00:00 4건 자동발행 스케줄러" `
    -Force | Out-Null

Write-Host "Registered task: $TaskName"
Write-Host "Start now: Start-ScheduledTask -TaskName '$TaskName'"
Start-ScheduledTask -TaskName $TaskName
Write-Host "Started."
