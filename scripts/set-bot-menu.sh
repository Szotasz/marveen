#!/bin/bash
# Telegram bot menu setup. Only runs for Telegram provider; Slack uses
# the App Manifest for slash commands.
# Called by channels.sh after plugin startup (with 15s delay).

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read provider from .env; skip if not telegram
if [ -f "$INSTALL_DIR/.env" ]; then
  CHANNEL_PROVIDER="$(grep -E '^CHANNEL_PROVIDER=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2-)"
fi
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
if [ "$CHANNEL_PROVIDER" != "telegram" ]; then
  exit 0
fi

# Load bot token
if [ -f "$HOME/.claude/channels/telegram/.env" ]; then
  BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$HOME/.claude/channels/telegram/.env" | cut -d= -f2)
elif [ -f "$INSTALL_DIR/.env" ]; then
  BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$INSTALL_DIR/.env" | cut -d= -f2)
fi

if [ -z "$BOT_TOKEN" ]; then
  echo "Bot token not found"
  exit 1
fi

# Wait for plugin to set its commands first
sleep 15

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "start", "description": "Üdvözlés és parancsok"},
      {"command": "ujchat", "description": "Új munkamenet indítása"},
      {"command": "napindito", "description": "Azonnali reggeli napindító"},
      {"command": "csapat", "description": "Ágensek listája és státusza"},
      {"command": "kanban", "description": "Kanban tábla összefoglaló"},
      {"command": "heartbeat", "description": "Heartbeat futtatás most"},
      {"command": "memoria", "description": "Memória keresés és összefoglaló"},
      {"command": "dashboard", "description": "Dashboard link (localhost:3420)"},
      {"command": "status", "description": "Futó feladatok állapota"},
      {"command": "cancel", "description": "Futó feladat megszakítása"}
    ]
  }' > /dev/null 2>&1

echo "Bot menu updated"
