#!/bin/bash
# Start Marveen services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Marveen inditas..."
launchctl load "$HOME/Library/LaunchAgents/com.marveen.dashboard.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.marveen.channels.plist" 2>/dev/null || true

echo "✓ Dashboard: http://localhost:3420"
echo "✓ Telegram csatorna inditva"
