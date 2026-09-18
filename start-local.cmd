@echo off
rem ===========================================================
rem  Daigan Ops Console - local-only launcher
rem  Same as start.cmd but binds 127.0.0.1 only: phones on the
rem  same WiFi cannot reach it. Use this on untrusted networks.
rem  Keep this file pure ASCII (see start.cmd for why).
rem ===========================================================
call "%~dp0start.cmd" --local %*
