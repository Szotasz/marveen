#!/bin/bash
# Start main agent services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read only what this script actually needs; avoid `set -a && source .env`,
# which would leak TELEGRAM_BOT_TOKEN into the environment and then into
# every tmux session the dashboard launches (see channels.sh for details).
if [ -f "$INSTALL_DIR/.env" ]; then
  SLUG="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
SLUG="${SLUG:-marveen}"

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
    nohup bun "$INSTALL_DIR/src/web/serve.ts" > "$INSTALL_DIR/store/dashboard.log" 2>&1 &
    echo $! > "$INSTALL_DIR/store/dashboard.pid"
    nohup bash "$INSTALL_DIR/scripts/channels.sh" > "$INSTALL_DIR/store/channels.log" 2>&1 &
    echo $! > "$INSTALL_DIR/store/channels.pid"
  fi
fi

echo "✓ Dashboard: http://localhost:3420"
echo "✓ Csatorna inditva"
