#!/bin/bash
# Stop Marveen services

echo "Marveen leallitas..."
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.marveen.dashboard.plist" 2>/dev/null
  launchctl unload "$HOME/Library/LaunchAgents/com.marveen.channels.plist" 2>/dev/null
elif [ "$OS" = "Linux" ]; then
  systemctl --user stop marveen-dashboard marveen-channels 2>/dev/null || true
fi

# Kill tmux sessions (mindkét platformon)
tmux kill-session -t marveen-channels 2>/dev/null || true
for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^agent-'); do
  tmux kill-session -t "$session" 2>/dev/null || true
done

echo "✓ Marveen leallitva"
