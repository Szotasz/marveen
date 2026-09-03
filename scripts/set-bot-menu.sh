#!/bin/bash
# Telegram bot menu setup. Only runs for Telegram provider; Slack uses
# the App Manifest for slash commands.
# Called by channels.sh after plugin startup (with 15s delay).

# Dashboard port: env WEB_PORT, else the install .env, else the 3420 default.
WEB_PORT="${WEB_PORT:-$(grep -E '^WEB_PORT=' "$(dirname "$0")/../.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' "')}"
WEB_PORT="${WEB_PORT:-3420}"

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

# Honest call (NOTIFYVAKSWEEP826): the old fire-and-forget curl printed
# "Bot menu updated" on transport failure and ok:false alike.
. "$INSTALL_DIR/scripts/lib/send-telegram.sh"
if telegram_api_call "$BOT_TOKEN" "setMyCommands" \
  -X POST \
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
      {"command": "dashboard", "description": "Dashboard link (localhost:'"${WEB_PORT:-3420}"')"},
      {"command": "status", "description": "Futó feladatok állapota"},
      {"command": "cancel", "description": "Futó feladat megszakítása"}
    ]
  }'; then
  echo "Bot menu updated"
else
  echo "Bot menu update FAILED (see error above)" >&2
  exit 1
fi
