:; if [ -z "" ]; then
:;   SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
:;   ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
:;   exec node "$ROOT_DIR/dist/agy-hud.js" statusline "$@"
:; fi
@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
node "%ROOT_DIR%\dist\agy-hud.js" statusline %*
