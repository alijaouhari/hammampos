# HammamPOS release: tests, version, build, zip, GitHub release, remote panel.
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 2.8.35 -Notes "What changed"
# Then deploy the dashboard (dashboard-deploy) so the remote panel matches the new version.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location (Split-Path -Parent $PSScriptRoot)
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 2.8.35" }
if (git status --porcelain -- src tests package.json) { throw 'Commit your changes in src/, tests/ and package.json first.' }

Step 'Tests'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed: nothing was released.' }

Step "Version $Version"
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($current -ne $Version) { npm version $Version --no-git-tag-version | Out-Null }

Step 'Build'
npm run build:win
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

Step 'Zip'
$zip = "dist\HammamPOS-v$Version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path 'dist\win-unpacked\*' -DestinationPath $zip
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $zip))
$hasExe = $z.Entries | Where-Object FullName -eq 'HammamPOS.exe'
$z.Dispose()
if (-not $hasExe) { throw 'HammamPOS.exe is missing from the zip.' }
Write-Host ("{0} ({1:N0} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))

Step 'Remote panel'
node scripts/build-remote-admin.js

Step 'Commit and publish'
git add package.json package-lock.json dashboard-deploy/admin.html dashboard-deploy/i18n.js dashboard-deploy/i18n-fr.js
git commit -q -m "release v$Version"
git push -q origin HEAD
if (-not $Notes) { $Notes = "HammamPOS v$Version" }
gh release create "v$Version" $zip --title "v$Version" --notes $Notes
if ($LASTEXITCODE -ne 0) { throw 'GitHub release failed (the build and commit are done; retry: gh release create).' }
Write-Host "`nReleased v$Version. Next: deploy dashboard-deploy, then install from the dashboard." -ForegroundColor Green
