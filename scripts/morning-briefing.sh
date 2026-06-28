#!/bin/bash
# Marveen - Reggeli napindító
# LaunchAgent hívja minden nap 7:27-kor

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="$(command -v claude)"
[ -z "$CLAUDE" ] && echo "ERROR: claude not found on PATH" >&2 && exit 1
LOG="$INSTALL_DIR/store/morning.log"

# Load config
if [ -f "$INSTALL_DIR/.env" ]; then
  export $(grep -v '^#' "$INSTALL_DIR/.env" | xargs)
fi

CHAT_ID="${ALLOWED_CHAT_ID:-0}"
CALENDAR_ID="${HEARTBEAT_CALENDAR_ID:-primary}"

echo "=== Reggeli napindító $(date) ===" >> "$LOG"

cd "$INSTALL_DIR"

# DEPRECATED: the live morning briefing is the `reggeli-napindito` scheduled
# task, which the schedule runner injects into the ALREADY RUNNING main session
# (no second poller). This standalone script is macOS-LaunchAgent-era legacy and
# is no longer triggered by anything. Kept only as a manual fallback. If ever
# run, route through the single-flight launcher so it cannot become a second
# concurrent poller on the main bot token (409 Conflict) while the main session
# is up -- the flock simply refuses and this exits.
LAUNCHER="$INSTALL_DIR/scripts/launch-channels-claude.sh"
[ -x "$LAUNCHER" ] || LAUNCHER="$CLAUDE"

CLAUDE="$CLAUDE" "$LAUNCHER" --dangerously-skip-permissions \
  --channels plugin:telegram@claude-plugins-official \
  -p "Reggeli napindító - készítsd el és küld el Telegramra (chat_id: $CHAT_ID).

1. Email check: search_emails az elmúlt 12 órából, szűrd ki a spam/promo emaileket
2. Naptár: list-events a mai napra a $CALENDAR_ID naptárból (Europe/Budapest timezone)
3. AI hírek: WebSearch \"AI news [tegnapi dátum]\"
4. Küld el Telegramra a reply tool-lal (chat_id: $CHAT_ID)

Tömör, lényegre törő. Ékezetesen írj magyarul." >> "$LOG" 2>&1

echo "=== Kész $(date) ===" >> "$LOG"
