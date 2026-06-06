#!/bin/bash
# Start main agent services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read only what this script actually needs; avoid `set -a && source .env`,
# which would leak TELEGRAM_BOT_TOKEN into the environment and then into
# every tmux session the dashboard launches (see channels.sh for details).
if [ -f "$INSTALL_DIR/.env" ]; then
  SLUG="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  GOOGLE_CLIENT_ID="$(grep -E '^GOOGLE_CLIENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  GOOGLE_CLIENT_SECRET="$(grep -E '^GOOGLE_CLIENT_SECRET=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
SLUG="${SLUG:-marveen}"

# Root VPS / container: claude refuses --dangerously-skip-permissions as uid 0.
# The dashboard (and the agent tmux sessions it spawns) hit the same wall as
# channels.sh, so export the sandbox escape hatch for the whole stack when root.
[ "$(id -u)" = "0" ] && export IS_SANDBOX=1

echo "${BOT_NAME:-Marveen} inditas..."
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  launchctl load "$HOME/Library/LaunchAgents/com.${SLUG}.dashboard.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.${SLUG}.channels.plist" 2>/dev/null || true
elif [ "$OS" = "Linux" ]; then
  if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    systemctl --user start "${SLUG}-dashboard" "${SLUG}-channels"
  else
    echo "systemd not available (WSL or container), using direct launch..."
    mkdir -p "$INSTALL_DIR/store"
    # The entry is src/index.ts (built to dist/index.js); the old src/web/serve.ts
    # is gone. better-sqlite3 is unsupported under bun (oven-sh/bun#4290), and on
    # some setups `node` on PATH actually resolves to bun -- so pick a real node
    # (its --version starts with "v"; bun's does not) and run the built output.
    NODE_BIN=""
    for cand in node nodejs; do
      cand_path="$(command -v "$cand" 2>/dev/null)" || continue
      case "$("$cand_path" --version 2>/dev/null)" in
        v*) NODE_BIN="$cand_path"; break ;;
      esac
    done
    if [ -z "$NODE_BIN" ]; then
      echo "ERROR: no real node found on PATH (bun cannot run better-sqlite3)." >&2
      exit 1
    fi
    [ -f "$INSTALL_DIR/dist/index.js" ] || (cd "$INSTALL_DIR" && npm run build)
    nohup "$NODE_BIN" "$INSTALL_DIR/dist/index.js" > "$INSTALL_DIR/store/dashboard.log" 2>&1 &
    echo $! > "$INSTALL_DIR/store/dashboard.pid"
    nohup bash "$INSTALL_DIR/scripts/channels.sh" > "$INSTALL_DIR/store/channels.log" 2>&1 &
    echo $! > "$INSTALL_DIR/store/channels.pid"
    if [ -n "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; then
      GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
        MCP_TRANSPORT=http nohup /home/jocoo/.npm-global/bin/google-sheets-mcp \
        > "$INSTALL_DIR/store/gsheets-mcp.log" 2>&1 &
      echo $! > "$INSTALL_DIR/store/gsheets-mcp.pid"
    fi
  fi
fi

echo "✓ Dashboard: http://localhost:3420"
echo "✓ Csatorna inditva"
[ -n "$GOOGLE_CLIENT_ID" ] && echo "✓ Google Sheets MCP: http://localhost:3000/mcp"
