@echo off
rem Pixel Melina portable launcher (app path must come BEFORE any switches)
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0electron\electron.exe" "%~dp0." --no-sandbox
