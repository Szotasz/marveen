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
# #915: main channel state is install-scoped once migrated; the legacy shared
# path only serves unmigrated installs.
TG_CHAN_DIR="${TELEGRAM_STATE_DIR:-}"
if [ -z "$TG_CHAN_DIR" ]; then
  TG_CHAN_DIR="$INSTALL_DIR/.claude/channels/telegram"
  [ -f "$TG_CHAN_DIR/.env" ] || TG_CHAN_DIR="$HOME/.claude/channels/telegram"
fi
if [ -f "$TG_CHAN_DIR/.env" ]; then
  BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$TG_CHAN_DIR/.env" | cut -d= -f2)
elif [ -f "$INSTALL_DIR/.env" ]; then
  BOT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$INSTALL_DIR/.env" | cut -d= -f2)
fi

if [ -z "$BOT_TOKEN" ]; then
  echo "Bot token not found"
  exit 1
fi

# Wait for plugin to set its commands first
sleep 15

# The menu (ELSOKOR922 spec D-4): the owner's registry commands (/status,
# /queue, /runs, /model, /usage, ... answered by the command hook without a
# model turn) come from the dashboard's registry, GET /api/commands/menu, so a
# new command cannot miss the menu. The agent's own instruction-level commands
# below stay static. The dashboard may still be starting: a few retries, then
# the static list alone (the registry commands still WORK, only the menu lacks
# them until the next channel start).
REGISTRY_JSON=""
DASH_TOKEN_FILE="$INSTALL_DIR/store/.dashboard-token"
if [ -s "$DASH_TOKEN_FILE" ]; then
  for _try in 1 2 3 4 5 6; do
    REGISTRY_JSON="$(curl -sS -m 10 -H "Authorization: Bearer $(cat "$DASH_TOKEN_FILE")" "http://127.0.0.1:${WEB_PORT}/api/commands/menu" 2>/dev/null)"
    case "$REGISTRY_JSON" in *'"commands"'*) break ;; esac
    REGISTRY_JSON=""
    sleep 10
  done
  [ -n "$REGISTRY_JSON" ] || echo "Registry menu unavailable (dashboard did not answer), static menu only" >&2
fi

MENU_JSON="$(REGISTRY_JSON="$REGISTRY_JSON" WEB_PORT="$WEB_PORT" python3 -c '
import json, os
static = [
    ("ujchat", "Új munkamenet indítása"),
    ("napindito", "Azonnali reggeli napindító"),
    ("csapat", "Ágensek listája és státusza"),
    ("kanban", "Kanban tábla összefoglaló"),
    ("heartbeat", "Heartbeat futtatás most"),
    ("memoria", "Memória keresés és összefoglaló"),
    ("dashboard", "Dashboard link (localhost:" + os.environ.get("WEB_PORT", "3420") + ")"),
    ("cancel", "Futó feladat megszakítása"),
]
try:
    registry = [(c["command"], c["description"]) for c in json.loads(os.environ.get("REGISTRY_JSON") or "{}").get("commands", [])]
except Exception:
    registry = []
out, seen = [], set()
for name, desc in [("start", "Üdvözlés és parancsok")] + registry + static:
    if name in seen:
        continue
    seen.add(name)
    out.append({"command": name, "description": desc[:256]})
print(json.dumps(out, ensure_ascii=False))
')"

# Honest call (NOTIFYVAKSWEEP826): the old fire-and-forget curl printed
# "Bot menu updated" on transport failure and ok:false alike.
#
# Two scopes: the default one, and all_private_chats -- the Telegram plugin
# used to set its own 3-entry menu on that narrower scope, which wins in a
# private chat and would keep hiding this one (patch-telegram-plugin.py now
# removes that call, but the old scoped menu persists on Telegram's side).
. "$INSTALL_DIR/scripts/lib/send-telegram.sh"
if telegram_api_call "$BOT_TOKEN" "setMyCommands" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"commands\": $MENU_JSON}" \
  && telegram_api_call "$BOT_TOKEN" "setMyCommands" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"commands\": $MENU_JSON, \"scope\": {\"type\": \"all_private_chats\"}}"; then
  echo "Bot menu updated"
else
  echo "Bot menu update FAILED (see error above)" >&2
  exit 1
fi
