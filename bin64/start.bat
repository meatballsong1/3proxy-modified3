@echo off
cd "C:\Users\mituy\Downloads\3proxy-modified\bin64"

:MENU
echo Select mode:
echo 1 - Only 3Proxy
echo 2 - 3Proxy + Node.js server
echo 3 - Exit
set /p MODE=Enter mode number (1, 2, or 3): 

if "%MODE%"=="1" (
    echo Starting 3proxy...
    start "" cmd /k "3proxy.exe 3proxy.cfg"
    goto END
)

if "%MODE%"=="2" (
    echo Starting 3proxy...
    start "" cmd /k "3proxy.exe 3proxy.cfg"
    echo Starting Node.js server...
    start "" cmd /k "nodemon server.js"
    goto END
)

if "%MODE%"=="3" (
    echo Exiting...
    goto END
)

echo Invalid input. Please enter 1, 2, or 3.
echo.
goto MENU

:END
echo All requested actions completed.
pause