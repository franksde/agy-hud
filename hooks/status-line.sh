#!/usr/bin/env sh
set -eu

# If node is missing from PATH, check for an existing NVM node binary
if ! command -v node >/dev/null 2>&1; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  # 1. Check if the default alias resolves to a valid binary
  if [ -x "$NVM_DIR/versions/node/$(cat "$NVM_DIR/alias/default" 2>/dev/null)/bin/node" ]; then
    NODE_BIN_DIR="$NVM_DIR/versions/node/$(cat "$NVM_DIR/alias/default")/bin"
    export PATH="$NODE_BIN_DIR:$PATH"
  # 2. Otherwise, check for any installed node version in NVM directory
  elif [ -d "$NVM_DIR/versions/node" ]; then
    LATEST_NODE_BIN=$(find "$NVM_DIR/versions/node" -maxdepth 2 -type d -name "bin" 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$LATEST_NODE_BIN" ] && [ -x "$LATEST_NODE_BIN/node" ]; then
      export PATH="$LATEST_NODE_BIN:$PATH"
    fi
  fi
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

exec node "$ROOT_DIR/dist/agy-hud.js" statusline
