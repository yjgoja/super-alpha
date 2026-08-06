$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "== deps =="
.\.venv\Scripts\python -m pip install -q -r requirements.txt pyinstaller

Write-Host "== build =="
if (Test-Path dist) { Remove-Item -Recurse -Force dist }
if (Test-Path build) { Remove-Item -Recurse -Force build }

.\.venv\Scripts\pyinstaller `
  --noconfirm `
  --clean `
  --windowed `
  --name "NaverBlogSEO" `
  --add-data "config.yaml;." `
  --hidden-import "PIL._tkinter_finder" `
  --collect-all selenium `
  --collect-all webdriver_manager `
  gui_app.py

$out = Join-Path $PSScriptRoot "dist\NaverBlogSEO_Release"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item "dist\NaverBlogSEO\*" $out -Recurse -Force
Copy-Item "config.yaml" $out -Force
Copy-Item ".env.example" (Join-Path $out ".env") -Force

$readme = @"
Naver Blog SEO Auto Poster

1. Run NaverBlogSEO.exe
2. Enter Naver ID / Password
3. Set keywords + required phrase, Save
4. Dry-run -> Once or Schedule

Auto-publish OFF by default. Chrome required.
"@
[System.IO.File]::WriteAllText(
  (Join-Path $out "README.txt"),
  $readme,
  [System.Text.UTF8Encoding]::new($false)
)

$zip = Join-Path $PSScriptRoot "dist\NaverBlogSEO_Release.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip -Force

Write-Host "EXE:" (Join-Path $out "NaverBlogSEO.exe")
Write-Host "ZIP:" $zip
Get-Item (Join-Path $out "NaverBlogSEO.exe"), $zip | Format-Table FullName, Length
