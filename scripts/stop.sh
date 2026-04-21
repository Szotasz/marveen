#!/bin/bash
# Stop main agent services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# See channels.sh for why we grep instead of `set -a && source`.
if [ -f "$INSTALL_DIR/.env" ]; then
  SLUG="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
  BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
SLUG="${SLUG:-marveen}"

echo "${BOT_NAME:-Marveen} leallitas..."
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.dashboard.plist" 2>/dev/null
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.channels.plist" 2>/dev/null
elif [ "$OS" = "Linux" ]; then
  systemctl --user stop "${SLUG}-dashboard" "${SLUG}-channels" 2>/dev/null || true
fi

# Stop the main channels tmux session. Do NOT kill sub-agent sessions --
# the dashboard restart (update flow) doesn't need them down, and this
# script doesn't bring them back up. Leaving them running keeps the
# update seamless for the operator.
tmux kill-session -t "${SLUG}-channels" 2>/dev/null || true

echo "✓ ${BOT_NAME:-Marveen} leallitva"
