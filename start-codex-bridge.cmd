@echo off
node "%~dp0scripts\codex-ferry.mjs" config
if errorlevel 1 pause
