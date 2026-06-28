# =============================================================================
# HammamPOS — One-Time Migration from v2.2.x
# =============================================================================
#
# Installs a SPECIFIC version to establish a known baseline.
# Handles all legacy issues: orphaned cmd.exe, stale batch scripts, partial updates.
#
# USAGE (run as Administrator):
#   powershell -ExecutionPolicy Bypass -File migrate-from-v2.2.ps1 -Version v2.3.1
#
# If -Version is omitted, defaults to v2.3.1 (the validated baseline).
#
# IDEMPOTENT: Safe to run multiple times. Will not damage a working installation.
# =============================================================================

param(
    [string]$Version = 'v2.3.1'
)

$ErrorActionPreference = 'Continue'

$installDir = 'C:\HammamPOS'
$updatesDir = Join-Path $env:APPDATA 'HammamPOS\updates'
$logsDir = Join-Path $env:APPDATA 'HammamPOS\Logs'
$logFile = Join-Path $logsDir 'Migration.log'
$owner = 'alijaouhari'
$repo = 'hammampos'
$releaseUrl = "https://api.github.com/repos/$owner/$repo/releases/tags/$Version"

# --- Ensure log directory ---
if (-not (Test-Path $logsDir)) { New-Item -Path $logsDir -ItemType Directory -Force | Out-Null }

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $entry = "[$ts] $msg"
    Write-Host $entry
    Add-Content -Path $logFile -Value $entry -ErrorAction SilentlyContinue
}

# --- Check admin ---
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: Must run as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell -> Run as Administrator" -ForegroundColor Yellow
    pause
    exit 1
}

Write-Log "=== MIGRATION STARTED ==="
Write-Log "Target version: $Version"
Write-Log "Install dir: $installDir"

# --- Step 1: Kill all HammamPOS processes ---
Write-Log "Step 1: Killing HammamPOS processes..."
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue

# --- Step 2: Kill orphaned cmd.exe running apply.bat ---
Write-Log "Step 2: Killing legacy cmd.exe (apply.bat)..."
$killed = 0
Get-WmiObject Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.CommandLine -match 'apply\.bat') {
        Write-Log "  Killing cmd.exe PID $($_.ProcessId): $($_.CommandLine)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
}
Write-Log "  Killed $killed legacy processes."

# --- Step 3: Remove legacy updater files ---
Write-Log "Step 3: Cleaning legacy files..."
$legacyFiles = @(
    (Join-Path $updatesDir 'apply.bat'),
    (Join-Path $env:TEMP 'hammampos-update.ps1'),
    (Join-Path $env:TEMP 'hammampos-updater.ps1'),
    (Join-Path $env:TEMP 'hammampos-revert.ps1')
)
foreach ($f in $legacyFiles) {
    if (Test-Path $f) {
        Remove-Item -Path $f -Force -ErrorAction SilentlyContinue
        Write-Log "  Removed: $f"
    }
}

# Remove stale staging/old directories
$staleDirs = @("$installDir-update", "$installDir-old", "$installDir-old-previous", "$installDir-removing")
foreach ($d in $staleDirs) {
    if (Test-Path $d) {
        Remove-Item -Path $d -Recurse -Force -ErrorAction SilentlyContinue
        Write-Log "  Removed: $d"
    }
}

# --- Step 4: Fetch specified release ---
Write-Log "Step 4: Fetching release $Version..."
try {
    $headers = @{ 'User-Agent' = 'HammamPOS-Migrator' }
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers -TimeoutSec 30
    $actualTag = $release.tag_name
    $zipAsset = $release.assets | Where-Object { $_.name -match '\.zip$' } | Select-Object -First 1

    if (-not $zipAsset) {
        Write-Log "ERROR: No ZIP asset found in release $actualTag"
        pause
        exit 1
    }

    $downloadUrl = $zipAsset.browser_download_url
    $expectedSize = $zipAsset.size
    Write-Log "  Release: $actualTag ($expectedSize bytes)"
    Write-Log "  URL: $downloadUrl"
} catch {
    Write-Log "ERROR: Cannot fetch release $Version from GitHub: $_"
    Write-Host ""
    Write-Host "Failed to reach GitHub or release not found." -ForegroundColor Red
    Write-Host "Verify the tag '$Version' exists at:" -ForegroundColor Yellow
    Write-Host "  https://github.com/$owner/$repo/releases/tag/$Version" -ForegroundColor Yellow
    pause
    exit 1
}

# --- Step 5: Download ---
Write-Log "Step 5: Downloading $actualTag..."
$zipPath = Join-Path $env:TEMP "HammamPOS-migration-$Version.zip"
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -TimeoutSec 300
    $actualSize = (Get-Item $zipPath).Length
    Write-Log "  Downloaded: $actualSize bytes"

    if ($expectedSize -and [Math]::Abs($actualSize - $expectedSize) -gt 1024) {
        Write-Log "ERROR: Size mismatch. Expected $expectedSize, got $actualSize"
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        pause
        exit 1
    }
} catch {
    Write-Log "ERROR: Download failed: $_"
    pause
    exit 1
}

# --- Step 6: Extract ---
Write-Log "Step 6: Extracting to $installDir..."
if (Test-Path $installDir) {
    try {
        Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
        Write-Log "  Extraction complete (overwrite mode)."
    } catch {
        Write-Log "  Overwrite failed, trying fresh extract..."
        Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
        Write-Log "  Fresh extraction complete."
    }
} else {
    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
    Write-Log "  Extraction complete (new install)."
}

# Verify
if (-not (Test-Path (Join-Path $installDir 'HammamPOS.exe'))) {
    Write-Log "ERROR: HammamPOS.exe not found after extraction!"
    pause
    exit 1
}
if (-not (Test-Path (Join-Path $installDir 'resources\app.asar'))) {
    Write-Log "ERROR: resources\app.asar not found after extraction!"
    pause
    exit 1
}
Write-Log "  Verification passed."

# --- Step 7: Cleanup ---
Write-Log "Step 7: Cleanup..."
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

if (Test-Path $updatesDir) {
    Get-ChildItem -Path $updatesDir -Filter '*.zip' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    }
}

# --- Step 8: Launch ---
Write-Log "Step 8: Launching HammamPOS..."
Start-Process -FilePath (Join-Path $installDir 'HammamPOS.exe')

Write-Log "=== MIGRATION COMPLETE ($actualTag) ==="
Write-Host ""
Write-Host "Migration successful! HammamPOS $actualTag installed." -ForegroundColor Green
Write-Host ""
pause
