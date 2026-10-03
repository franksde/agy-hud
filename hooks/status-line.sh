#!/usr/bin/env sh
set -eu

# Fallback: add NVM default bin and common paths to PATH if node isn't found
if ! command -v node >/dev/null 2>&1; then
  # Checks standard NVM default alias symlink, or scans installed NVM versions
  if [ -d "$HOME/.nvm/versions/node" ]; then
    NODE_PATH=$(find "$HOME/.nvm/versions/node" -maxdepth 2 -type d -name "bin" 2>/dev/null | sort -V | tail -n 1)
    [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH:$PATH"
  fi
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

exec node "$ROOT_DIR/dist/agy-hud.js" statusline
