@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   代肝价格查询 · 私用运营台
echo   ---------------------------------------------
echo.

rem ---- 找 Node.js：先看 PATH，再翻常见安装位置 ----
set "NODE_EXE="
for %%I in (node.exe) do if not defined NODE_EXE if exist "%%~$PATH:I" set "NODE_EXE=%%~$PATH:I"

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"

if not defined NODE_EXE (
  echo   [x] 没找到 Node.js。
  echo.
  echo   这个后台需要 Node.js 22.5 或更高版本（用到内置的 SQLite）。
  echo   打开 https://nodejs.org 下载 LTS 版本，一路下一步装好，
  echo   然后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%V in ('"!NODE_EXE!" -v') do set "NODEVER=%%V"
echo   使用 Node !NODEVER!
echo   !NODE_EXE!
echo.

"!NODE_EXE!" server.mjs %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo   后台已退出（代码 %CODE%）。上面如果有红字，多半是端口被占用，
  echo   可以换端口重开：start.cmd --port 8888
  echo.
  pause
)
endlocal
