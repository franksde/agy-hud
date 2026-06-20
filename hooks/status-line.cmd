:; exec node "`dirname \"$0\"`/../dist/agy-hud.js" statusline "$@"
@echo off
echo "Diagnostic: status-line.cmd started" >> "%TMP%\hud-debug.log" 2>nul
echo "Path: %~dp0" >> "%TMP%\hud-debug.log" 2>nul
node "%~dp0..\dist\agy-hud.js" statusline %* 2>> "%TMP%\hud-debug.log"
echo "Exit code: %errorlevel%" >> "%TMP%\hud-debug.log" 2>nul
exit /b %errorlevel%
