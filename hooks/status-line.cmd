@echo off
setlocal

rem The `agy -p /usage` that a quota refresh starts sets AGY_HUD_NESTED=1 and
rem redraws its own status line several times. Print mode never shows it, so
rem drain the payload and leave without starting node.
if "%AGY_HUD_NESTED%"=="1" (
  for /f "delims=" %%i in ('more') do rem
  exit /b 0
)

rem Ensure node is available on PATH
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo agy-hud: node not found on PATH >&2
  exit /b 127
)

rem Execute agy-hud bundle with statusline command
node "%~dp0..\dist\agy-hud.js" statusline
