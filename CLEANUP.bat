@echo off
echo ========================================
echo HammamPOS - Project Cleanup
echo ========================================
echo.

echo This will clean up:
echo - Build artifacts (dist folder)
echo - Node modules cache
echo - Temporary files
echo.
echo Your source code and data will NOT be deleted.
echo.

set /p confirm="Continue with cleanup? (Y/N): "
if /i not "%confirm%"=="Y" (
    echo Cleanup cancelled.
    pause
    exit /b 0
)

echo.
echo Starting cleanup...
echo.

REM Clean dist folder
if exist "dist" (
    echo Cleaning dist folder...
    rmdir /s /q "dist" 2>nul
    echo ✅ dist folder cleaned
) else (
    echo ℹ️ dist folder not found
)

REM Clean node_modules (optional - will need reinstall)
echo.
set /p clean_modules="Also clean node_modules? (requires npm install later) (Y/N): "
if /i "%clean_modules%"=="Y" (
    if exist "node_modules" (
        echo Cleaning node_modules... (this may take a while)
        rmdir /s /q "node_modules" 2>nul
        echo ✅ node_modules cleaned
        echo ⚠️ Run 'npm install' before next use
    )
)

REM Clean npm cache
echo.
echo Cleaning npm cache...
call npm cache clean --force 2>nul
echo ✅ npm cache cleaned

REM Clean temporary files
if exist "*.log" (
    echo Cleaning log files...
    del /q *.log 2>nul
    echo ✅ Log files cleaned
)

echo.
echo ========================================
echo ✅ Cleanup completed!
echo ========================================
echo.
echo Next steps:
if /i "%clean_modules%"=="Y" (
    echo 1. Run: npm install
    echo 2. Run: BUILD_FOR_DEPLOYMENT.bat
) else (
    echo 1. Run: BUILD_FOR_DEPLOYMENT.bat
)
echo.
pause