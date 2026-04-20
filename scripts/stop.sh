#!/bin/bash
# Stop main agent services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$INSTALL_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$INSTALL_DIR/.env"
  set +a
fi
SLUG="${MAIN_AGENT_ID:-marveen}"

echo "${BOT_NAME:-Marveen} leallitas..."
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.dashboard.plist" 2>/dev/null
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.channels.plist" 2>/dev/null
elif [ "$OS" = "Linux" ]; then
  systemctl --user stop "${SLUG}-dashboard" "${SLUG}-channels" 2>/dev/null || true
fi

# Kill tmux sessions (mindkét platformon)
tmux kill-session -t "${SLUG}-channels" 2>/dev/null || true
for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^agent-'); do
  tmux kill-session -t "$session" 2>/dev/null || true
done

echo "✓ ${BOT_NAME:-Marveen} leallitva"
