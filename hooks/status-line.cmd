:; if [ -z "" ]; then
:;   echo "status-line polyglot executed in SH" >> /tmp/hud-debug.log 2>/dev/null || true
:;   SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
:;   ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
:;   echo "Calling node $ROOT_DIR/dist/agy-hud.js statusline" >> /tmp/hud-debug.log 2>/dev/null || true
:;   exec node "$ROOT_DIR/dist/agy-hud.js" statusline "$@"
:; fi
@echo off
setlocal

echo status-line polyglot executed in CMD >> "%TMP%\hud-debug.log" 2>nul
set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
echo Calling node %ROOT_DIR%\dist\agy-hud.js statusline >> "%TMP%\hud-debug.log" 2>nul
node "%ROOT_DIR%\dist\agy-hud.js" statusline %*
