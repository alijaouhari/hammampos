@echo off
echo.
echo ══════════════════════════════════════════════
echo   HammamPOS - Full Validation Pipeline
echo ══════════════════════════════════════════════
echo.

if not exist "package.json" (
    echo ERROR: Run from project root.
    exit /b 1
)

echo [1/3] Unit Tests...
node tests/validate-updater.js
if errorlevel 1 (
    echo.
    echo UNIT TESTS FAILED. Stopping.
    exit /b 1
)

echo.
echo [2/3] Release Pipeline Validation...
node tests/validate-release-pipeline.js
if errorlevel 1 (
    echo.
    echo PIPELINE VALIDATION FAILED. Stopping.
    exit /b 1
)

echo.
echo [3/3] VBS Launcher Integration...
node tests/test-vbs-launch.js
if errorlevel 1 (
    echo.
    echo VBS LAUNCHER TEST FAILED. Stopping.
    exit /b 1
)

echo.
echo ══════════════════════════════════════════════
echo   ALL VALIDATIONS PASSED
echo ══════════════════════════════════════════════
echo.
