#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -W 2>/dev/null || CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
exec node "$ROOT_DIR/dist/agy-hud.js" statusline "$@"
