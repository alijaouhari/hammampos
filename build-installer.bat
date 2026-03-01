@echo off
echo ========================================
echo HammamPOS Professional Installer Builder
echo ========================================
echo.

REM Check if Inno Setup is installed
if not exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
    echo ERROR: Inno Setup 6 not found!
    echo.
    echo Please install Inno Setup 6 from:
    echo https://jrsoftware.org/isdl.php
    echo.
    pause
    exit /b 1
)

REM Check if Node.js project is built
if not exist "dist\win-unpacked" (
    echo Building Electron application...
    call npm run build:win
    if errorlevel 1 (
        echo ERROR: Failed to build Electron application
        pause
        exit /b 1
    )
) else (
    echo Electron application already built.
)

REM Create necessary directories
if not exist "dist" mkdir dist
if not exist "resources" mkdir resources

REM Check for required files
if not exist "resources\icon.ico" (
    echo WARNING: Application icon not found at resources\icon.ico
    echo Using default icon...
    copy /y "src\renderer\favicon.ico" "resources\icon.ico" 2>nul
)

if not exist "LICENSE.txt" (
    echo Creating default license file...
    echo HammamPOS Professional License > LICENSE.txt
    echo Copyright (c) 2024 HammamPOS Solutions >> LICENSE.txt
    echo All rights reserved. >> LICENSE.txt
)

echo.
echo Building installer with Inno Setup...
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "installer\hammampos-setup.iss"

if errorlevel 1 (
    echo.
    echo ERROR: Installer build failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo SUCCESS: Installer built successfully!
echo ========================================
echo.
echo Installer location: dist\HammamPOS-Setup-2.0.0.exe
echo.

REM Show file size
for %%I in ("dist\HammamPOS-Setup-2.0.0.exe") do (
    echo File size: %%~zI bytes
)

echo.
echo Ready for distribution!
pause