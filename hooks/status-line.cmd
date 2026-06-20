:; exec node "`dirname \"$0\"`/../dist/agy-hud.js" statusline "$@"
@echo off
node "%~dp0..\dist\agy-hud.js" statusline %*
exit /b %errorlevel%
