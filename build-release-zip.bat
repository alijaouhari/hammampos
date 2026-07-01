@echo off
setlocal enabledelayedexpansion
echo ========================================
echo HammamPOS - Build Release ZIP
echo ========================================
echo.

REM This script builds the Electron app and creates a ZIP file
REM ready for upload to GitHub Releases.
REM The ZIP contains the portable app directory that the updater
REM extracts directly to C:\HammamPOS.

REM Check prerequisites
if not exist "package.json" (
    echo ERROR: Run this from hammampos-desktop folder
    pause
    exit /b 1
)

REM Get version from package.json
for /f "tokens=2 delims=:, " %%a in ('findstr "version" package.json') do (
    set RAW_VERSION=%%~a
    goto :found_version
)
:found_version
set VERSION=%RAW_VERSION:"=%
echo Version: %VERSION%
echo.

REM Step 1: Build
echo Step 1: Building Electron application...
call npm run build:win
if errorlevel 1 (
    echo ERROR: Build failed
    pause
    exit /b 1
)
echo OK: Build complete.
echo.

REM Step 2: Verify the unpacked directory exists
if not exist "dist\win-unpacked\HammamPOS.exe" (
    echo ERROR: dist\win-unpacked\HammamPOS.exe not found
    pause
    exit /b 1
)
if not exist "dist\win-unpacked\resources\app.asar" (
    echo ERROR: dist\win-unpacked\resources\app.asar not found
    pause
    exit /b 1
)
echo OK: Required files present.
echo.

REM Step 3: Create ZIP
set ZIPNAME=HammamPOS-v%VERSION%.zip
set ZIPPATH=dist\%ZIPNAME%

echo Step 3: Creating %ZIPNAME%...
if exist "%ZIPPATH%" del "%ZIPPATH%"

powershell -NoProfile -Command "Compress-Archive -Path 'dist\win-unpacked\*' -DestinationPath '%ZIPPATH%' -Force"
if errorlevel 1 (
    echo ERROR: ZIP creation failed
    pause
    exit /b 1
)

REM Verify ZIP
for %%I in ("%ZIPPATH%") do set ZIPSIZE=%%~zI
echo OK: %ZIPNAME% created (%ZIPSIZE% bytes)
echo.

REM Step 4: Validate ZIP contents
echo Step 4: Validating ZIP contents...
powershell -NoProfile -Command "$zip = [IO.Compression.ZipFile]::OpenRead('%ZIPPATH%'); $entries = $zip.Entries.Name; $zip.Dispose(); if ($entries -contains 'HammamPOS.exe') { exit 0 } else { Write-Host 'MISSING: HammamPOS.exe in ZIP'; exit 1 }"
if errorlevel 1 (
    echo ERROR: ZIP validation failed - HammamPOS.exe not found inside
    pause
    exit /b 1
)
echo OK: ZIP validated.
echo.

echo ========================================
echo SUCCESS!
echo ========================================
echo.
echo Release ZIP: dist\%ZIPNAME%
echo Size: %ZIPSIZE% bytes
echo.
echo Next steps:
echo   1. Create a GitHub release with tag v%VERSION%
echo   2. Upload dist\%ZIPNAME% as a release asset
echo   3. The updater will detect it on next check
echo.
echo Or use: gh release create v%VERSION% "%ZIPPATH%" --title "v%VERSION%"
echo.
pause
