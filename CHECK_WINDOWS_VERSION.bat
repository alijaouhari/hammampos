@echo off
echo ========================================
echo HammamPOS - Windows Compatibility Check
echo ========================================
echo.

echo Checking Windows version...
echo.

REM Get Windows version
for /f "tokens=4-5 delims=. " %%i in ('ver') do set VERSION=%%i.%%j

echo Your Windows version: %VERSION%
echo.

REM Check version
if "%VERSION%"=="10.0" (
    echo ✅ Windows 10 or 11 detected
    echo ✅ PERFECT! All features will work.
    echo.
    echo You can install HammamPOS without any issues.
) else if "%VERSION%"=="6.3" (
    echo ✅ Windows 8.1 detected
    echo ⚠️ GOOD! All features work, but consider upgrading.
    echo.
    echo Installer will show a compatibility warning.
    echo You can proceed with installation.
) else if "%VERSION%"=="6.2" (
    echo ✅ Windows 8 detected
    echo ⚠️ GOOD! All features work, but consider upgrading.
    echo.
    echo Installer will show a compatibility warning.
    echo You can proceed with installation.
) else if "%VERSION%"=="6.1" (
    echo ⚠️ Windows 7 detected
    echo ⚠️ LIMITED SUPPORT! Core features work, some limitations.
    echo.
    echo IMPORTANT:
    echo - Core POS features will work
    echo - Web dashboard may have issues
    echo - Cloud sync may have issues
    echo - Consider upgrading to Windows 10
    echo.
    echo Read WINDOWS_COMPATIBILITY.md before installing.
) else if "%VERSION%"=="6.0" (
    echo ❌ Windows Vista detected
    echo ❌ NOT SUPPORTED! Too old.
    echo.
    echo Please upgrade to Windows 10 or 11.
) else (
    echo ❌ Windows XP or older detected
    echo ❌ NOT SUPPORTED! Too old.
    echo.
    echo Please upgrade to Windows 10 or 11.
)

echo.
echo ========================================
echo System Information:
echo ========================================
systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type"

echo.
echo ========================================
echo Recommendations:
echo ========================================
echo.
if "%VERSION%"=="10.0" (
    echo ✅ Your system is perfect for HammamPOS!
    echo    Proceed with installation.
) else if "%VERSION%"=="6.3" (
    echo ⚠️ Your system will work, but consider:
    echo    - Upgrading to Windows 10 or 11
    echo    - Testing all features after installation
) else if "%VERSION%"=="6.2" (
    echo ⚠️ Your system will work, but consider:
    echo    - Upgrading to Windows 10 or 11
    echo    - Testing all features after installation
) else if "%VERSION%"=="6.1" (
    echo ⚠️ Your system has limited support:
    echo    - Test core features only
    echo    - Avoid web dashboard and cloud sync
    echo    - Strongly consider upgrading to Windows 10
) else (
    echo ❌ Your system is too old:
    echo    - Upgrade to Windows 10 or 11 first
    echo    - Do not attempt installation
)

echo.
pause