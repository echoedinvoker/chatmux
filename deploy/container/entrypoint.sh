#!/bin/sh
# Seed a zero-adapter config on first boot, then hand off to the daemon.
#
# Zero adapters is not a workaround for the 120s login timeout: with no platforms
# configured the daemon's waitForConnections resolves immediately, so startup goes
# straight to the MCP listener. It is the normal path, not a shortcut.
set -eu

mkdir -p "$CHATMUX_DATA_DIR"

if [ ! -f "$CHATMUX_DATA_DIR/adapters.json" ]; then
  echo '{"adapters": []}' > "$CHATMUX_DATA_DIR/adapters.json"
fi

exec bun run src/core/daemon.ts
