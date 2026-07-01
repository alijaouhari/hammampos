@echo off
setlocal enabledelayedexpansion
echo.
echo ══════════════════════════════════════════════════════
echo   HammamPOS - Automated Release Pipeline
echo ══════════════════════════════════════════════════════
echo.

if not exist "package.json" (
    echo ERROR: Run from project root.
    exit /b 1
)

REM Get version
for /f "tokens=2 delims=:, " %%a in ('findstr /c:"\"version\"" package.json') do (
    set RAW_VERSION=%%~a
    goto :got_ver
)
:got_ver
set VERSION=%RAW_VERSION:"=%
echo Version: %VERSION%
echo.

REM ── Step 1: Pre-build validation ──────────────────────
echo [Step 1] Pre-build validation...
node tests/validate-updater.js >nul 2>&1
if errorlevel 1 (
    echo FAIL: Unit tests failed. Fix before releasing.
    node tests/validate-updater.js
    exit /b 1
)
echo   OK: Unit tests passed.
echo.

REM ── Step 2: Build ─────────────────────────────────────
echo [Step 2] Building Electron app...
call npm run build:win
if errorlevel 1 (
    echo FAIL: Build failed.
    exit /b 1
)
echo   OK: Build complete.
echo.

REM ── Step 3: Create release ZIP ────────────────────────
set ZIPNAME=HammamPOS-v%VERSION%.zip
set ZIPPATH=dist\%ZIPNAME%
echo [Step 3] Creating %ZIPNAME%...

if not exist "dist\win-unpacked\HammamPOS.exe" (
    echo FAIL: dist\win-unpacked\HammamPOS.exe missing
    exit /b 1
)
if exist "%ZIPPATH%" del "%ZIPPATH%"
powershell -NoProfile -Command "Compress-Archive -Path 'dist\win-unpacked\*' -DestinationPath '%ZIPPATH%' -Force"
if errorlevel 1 (
    echo FAIL: ZIP creation failed.
    exit /b 1
)
for %%I in ("%ZIPPATH%") do set ZIPSIZE=%%~zI
echo   OK: %ZIPNAME% (%ZIPSIZE% bytes)
echo.

REM ── Step 4: Full pipeline validation ──────────────────
echo [Step 4] Full pipeline validation...
node tests/validate-release-pipeline.js
if errorlevel 1 (
    echo FAIL: Pipeline validation failed. Do NOT publish.
    exit /b 1
)
echo.

REM ── Step 5: Publish to GitHub ─────────────────────────
echo [Step 5] Publishing to GitHub...
echo.

REM Check if gh CLI is available
gh --version >nul 2>&1
if errorlevel 1 (
    echo WARNING: GitHub CLI not found.
    echo Manual publish required:
    echo   gh release create v%VERSION% "%ZIPPATH%" --title "v%VERSION%"
    echo.
    goto :done
)

REM Check if tag already exists
gh release view v%VERSION% >nul 2>&1
if not errorlevel 1 (
    echo WARNING: Release v%VERSION% already exists on GitHub.
    echo   To overwrite: gh release delete v%VERSION% -y
    echo   Then re-run this script.
    goto :done
)

echo About to create GitHub release v%VERSION% with %ZIPNAME%
echo.
set /p CONFIRM=Publish? (y/N): 
if /i not "%CONFIRM%"=="y" (
    echo Cancelled. ZIP ready at: %ZIPPATH%
    goto :done
)

gh release create v%VERSION% "%ZIPPATH%" --title "v%VERSION%" --notes "HammamPOS v%VERSION%"
if errorlevel 1 (
    echo FAIL: GitHub release creation failed.
    exit /b 1
)
echo.
echo   OK: Release v%VERSION% published to GitHub.
echo.

:done
echo ══════════════════════════════════════════════════════
echo   RELEASE PIPELINE COMPLETE
echo ══════════════════════════════════════════════════════
echo.
echo   Version:  %VERSION%
echo   ZIP:      %ZIPPATH%
echo   Size:     %ZIPSIZE% bytes
echo.
