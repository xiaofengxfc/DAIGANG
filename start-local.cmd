@echo off
chcp 65001 >nul
rem 只允许本机访问：手机连不上，但也没有局域网被偷看密码的风险。
call "%~dp0start.cmd" --local %*
