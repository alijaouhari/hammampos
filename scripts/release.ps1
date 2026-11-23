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
# Runs a program (git, npm, gh, node) and stops on a real failure only. Windows
# PowerShell 5 turns any text a program writes to stderr into an error when output
# is redirected (e.g. git's "LF will be replaced by CRLF" warning), which used to
# stop this script silently after the build. Here only the exit code counts.
function Run([string]$what) {
  $exe, $rest = $args
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @rest 2>&1 | ForEach-Object { "$_" } | Write-Host; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $old }
  if ($code -ne 0) { throw "$what failed (exit code $code)." }
}
trap { Write-Host "`nRELEASE STOPPED: $_" -ForegroundColor Red; exit 1 }

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version must look like 2.8.35" }
if (git status --porcelain -- src tests package.json) { throw 'Commit your changes in src/, tests/ and package.json first.' }

Step 'Tests'
Run 'Tests (nothing was released)' npm test

Step "Version $Version"
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if ($current -ne $Version) { Run 'Version bump' npm version $Version --no-git-tag-version }

Step 'Build'
Run 'Build' npm run build:win

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
Run 'Remote panel' node scripts/build-remote-admin.js

Step 'Commit and publish'
Run 'git add' git add package.json package-lock.json dashboard-deploy/admin.html dashboard-deploy/i18n.js dashboard-deploy/i18n-fr.js
Run 'git commit' git commit -q -m "release v$Version"
Run 'git push' git push -q origin HEAD
if (-not $Notes) { $Notes = "HammamPOS v$Version" }
Run 'GitHub release (the build and commit are done; retry: gh release create)' gh release create "v$Version" $zip --title "v$Version" --notes $Notes
Write-Host "`nReleased v$Version. Next: deploy dashboard-deploy, then install from the dashboard." -ForegroundColor Green
