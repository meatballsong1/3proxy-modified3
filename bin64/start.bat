@echo off
echo Starting 3proxy...
cd "C:\Users\mituy\Downloads\3proxy-modified\bin64"
start "" cmd /k "3proxy.exe 3proxy.cfg"
echo Starting Node.js server...
cd "C:\Users\mituy\Downloads\3proxy-modified\bin64"
start "" cmd /k "nodemon server.js"
echo All services started.
pause