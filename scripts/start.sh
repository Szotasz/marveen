#!/bin/bash
# Start main agent services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$INSTALL_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/.env"
  set +a
fi
SLUG="${MAIN_AGENT_ID:-marveen}"

echo "${BOT_NAME:-Marveen} inditas..."
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  launchctl load "$HOME/Library/LaunchAgents/com.${SLUG}.dashboard.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.${SLUG}.channels.plist" 2>/dev/null || true
elif [ "$OS" = "Linux" ]; then
  systemctl --user start "${SLUG}-dashboard" "${SLUG}-channels"
fi

echo "✓ Dashboard: http://localhost:3420"
echo "✓ Telegram csatorna inditva"
