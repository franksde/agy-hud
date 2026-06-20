#!/usr/bin/env sh
set -eu
echo "Diagnostic: status-line.sh started" >> "${TMP:-/tmp}/hud-debug.log" || true
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
node "$ROOT_DIR/dist/agy-hud.js" statusline "$@" 2>> "${TMP:-/tmp}/hud-debug.log"
echo "Exit code: $?" >> "${TMP:-/tmp}/hud-debug.log" || true
