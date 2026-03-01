@echo off
echo ========================================
echo HammamPOS - Build for Deployment
echo ========================================
echo.

REM Check if in correct directory
if not exist "package.json" (
    echo ERROR: Run this from hammampos-desktop folder
    pause
    exit /b 1
)

echo Step 1: Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found
    echo Install from: https://nodejs.org/
    pause
    exit /b 1
)
echo ✅ Node.js found

echo.
echo Step 2: Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)
echo ✅ Dependencies installed

echo.
echo Step 3: Building installer...
call npm run build:win
if errorlevel 1 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo ✅ BUILD SUCCESSFUL!
echo ========================================
echo.
echo Installer location:
dir /b dist\*.exe 2>nul
echo.
echo Full path:
cd
echo \dist\
echo.
echo Next steps:
echo 1. Copy installer to USB drive
echo 2. Take it to target machine
echo 3. Follow QUICK_TEST_CHECKLIST.md
echo.
pause