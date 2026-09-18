@echo off
rem ===========================================================
rem  Daigan Ops Console - Windows launcher
rem
rem  TWO RULES FOR THIS FILE - both learned the hard way:
rem
rem  1) KEEP IT PURE ASCII.
rem     cmd.exe decodes .cmd files using the system codepage, so
rem     UTF-8 Chinese text here turns into mojibake and gets split
rem     into bogus commands. All Chinese output comes from Node.
rem
rem  2) NEVER INVOKE node WITHOUT call.
rem     On machines where "node" resolves to a .cmd/.bat shim,
rem     calling it from a .cmd transfers control away and this
rem     script dies on the spot. Hence every invocation uses call.
rem
rem  Also deliberately pipe-free: no "for /f ('command')" probing.
rem ===========================================================
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"

set "NODE_EXE="

rem ---- 1) is node already on PATH? call makes .cmd shims safe ----
call node -v >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"

rem ---- 2) usual install locations ----
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"

rem ---- 3) scoop / chocolatey shims ----
if not defined NODE_EXE if exist "%USERPROFILE%\scoop\shims\node.exe" set "NODE_EXE=%USERPROFILE%\scoop\shims\node.exe"
if not defined NODE_EXE if exist "%ProgramData%\chocolatey\bin\node.exe" set "NODE_EXE=%ProgramData%\chocolatey\bin\node.exe"

if not defined NODE_EXE goto :no_node

echo.
echo   Node: %NODE_EXE%
call "%NODE_EXE%" -v
echo.

rem call keeps control here even when node is a .cmd/.bat shim
call "%NODE_EXE%" server.mjs %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" goto :failed
goto :done

:no_node
echo.
echo   =========================================================
echo    Node.js not found on this computer.
echo   =========================================================
echo.
echo    This console needs Node.js version 22.5 or newer.
echo.
echo    1. Open  https://nodejs.org
echo    2. Download the LTS version and install it
echo       (keep clicking Next, the default options are fine)
echo    3. Double-click start.cmd again
echo.
echo    Already installed but still seeing this? Close this window,
echo    open a NEW one and try again - a PATH change only applies
echo    to newly opened windows.
echo.
pause
goto :done

:failed
echo.
echo   =========================================================
echo    The console stopped (exit code %CODE%).
echo   =========================================================
echo.
echo    If the message above says the port is already in use,
echo    start it on another port instead:
echo.
echo        start.cmd --port 8888
echo.
pause

:done
endlocal
