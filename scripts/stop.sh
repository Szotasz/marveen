#!/bin/bash
# Stop Marveen services

echo "Marveen leallitas..."
launchctl unload "$HOME/Library/LaunchAgents/com.marveen.dashboard.plist" 2>/dev/null
launchctl unload "$HOME/Library/LaunchAgents/com.marveen.channels.plist" 2>/dev/null

# Kill tmux sessions
tmux kill-session -t claudeclaw-channels 2>/dev/null || true
for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^agent-'); do
  tmux kill-session -t "$session" 2>/dev/null || true
done

echo "✓ Marveen leallitva"
