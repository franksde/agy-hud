@echo off
setlocal

rem cmd.exe looks for a bare command name in the current directory before
rem PATH, and the status line runs in the user's workspace, so every program
rem here is named by its full path or found through PATH alone. A node.bat or
rem more.com that a repository ships must never run.

rem The `agy -p /usage` that a quota refresh starts sets AGY_HUD_NESTED=1 and
rem redraws its own status line several times. Print mode never shows it, so
rem drain the payload and leave without starting node.
if "%AGY_HUD_NESTED%"=="1" (
  "%SystemRoot%\System32\more.com" >nul 2>nul
  exit /b 0
)

rem %%~$PATH:i searches the PATH directories only, not the current one first.
set "AGY_HUD_NODE="
for %%i in (node.exe) do set "AGY_HUD_NODE=%%~$PATH:i"
if not defined AGY_HUD_NODE (
  echo agy-hud: node not found on PATH>&2
  exit /b 127
)

"%AGY_HUD_NODE%" "%~dp0..\dist\agy-hud.js" statusline
