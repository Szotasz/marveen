#!/bin/bash
# Marveen - Ertesites kuldes Telegram-ra
# Hasznalat: ./scripts/notify.sh "Uzenet szovege"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Hiba: .env fajl nem talalhato: $ENV_FILE"
  exit 1
fi

TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID=$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)
MAIN_AGENT_ID=$(grep '^MAIN_AGENT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2-)
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"

if [ -z "$TOKEN" ]; then
  echo "Hiba: TELEGRAM_BOT_TOKEN nincs beallitva"
  exit 1
fi

if [ -z "$CHAT_ID" ]; then
  echo "Hiba: ALLOWED_CHAT_ID nincs beallitva"
  exit 1
fi

MESSAGE="$1"
if [ -z "$MESSAGE" ]; then
  echo "Hasznalat: $0 \"uzenet\""
  exit 1
fi

# Sender attribution: notify.sh always uses the main bot token, so without this
# every notification reads as the main bot. Detect the calling agent from the
# tmux session name and prefix the message when it is NOT the main agent, so the
# reader can see who it came from. Distribution-safe: the main agent id is read
# from .env (default marveen), no hardcoded names.
SENDER=""
# Only ask tmux who we are when we are actually INSIDE a tmux pane. Detached
# callers -- cron, systemd, a plain ssh shell -- have no session, but
# `tmux display-message -p '#S'` still answers happily with whatever session the
# server most recently touched. That mislabels a cron- or systemd-fired system
# alert as coming from an arbitrary agent, which is worse than no attribution: it
# points the reader at an uninvolved agent while a system alert is in flight.
# No pane -> no claim about the sender; the message goes out as the main agent.
SESS=""
if [ -n "${TMUX:-}" ]; then
  SESS=$(tmux display-message -p '#S' 2>/dev/null)
fi
case "$SESS" in
  agent-*)
    SENDER="${SESS#agent-}"
    ;;
  "${MAIN_AGENT_ID}-channels"|"${MAIN_AGENT_ID}-worker")
    SENDER="$MAIN_AGENT_ID"
    ;;
  *)
    SENDER=""
    ;;
esac

if [ -n "$SENDER" ] && [ "$SENDER" != "$MAIN_AGENT_ID" ]; then
  # Capitalize the first letter (bash 3.2 portable -- no ${var^}).
  _first=$(printf '%s' "${SENDER%"${SENDER#?}"}" | tr '[:lower:]' '[:upper:]')
  SENDER_CAP="${_first}${SENDER#?}"
  MESSAGE="🤖 ${SENDER_CAP}:
${MESSAGE}"
fi

# Test-run marker: a test runner (vitest exports VITEST to every child
# process; NODE_ENV=test for other runners) that reaches this script sends a
# REAL message with the production token read from .env -- so it must be
# labelled, not suppressed (the owner wants proof the alert path works).
# Mirrors src/test-run-marker.ts.
if [ -n "${VITEST:-}" ] || [ "${NODE_ENV:-}" = "test" ]; then
  MESSAGE="[TESZT] ${MESSAGE}"
fi

# Delivery must be HONEST (NOTIFYVAK826): this script is the fleet's FALLBACK
# channel, used exactly when the primary Telegram plugin is already down. A
# swallowed curl failure here reported success while nothing was delivered --
# indistinguishable, from the owner's side, from "nothing happened". Success
# therefore requires BOTH a clean curl exit AND the Bot API's own "ok":true
# (an HTTP 200 with ok:false -- bad chat_id, parse error -- exits 0 in curl).
RESPONSE=$(curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}" \
  -d "text=${MESSAGE}" \
  -d "parse_mode=HTML" 2>&1)
CURL_EXIT=$?
# Never echo the bot token: some curl errors quote the request URL.
RESPONSE="${RESPONSE//${TOKEN}/<token>}"

if [ $CURL_EXIT -ne 0 ]; then
  echo "Hiba: ertesites kuldese sikertelen (curl exit ${CURL_EXIT}): ${RESPONSE}" >&2
  exit 1
fi

case "$RESPONSE" in
  *'"ok":true'*)
    echo "Ertesites elkuldve."
    ;;
  *)
    echo "Hiba: a Telegram API elutasitotta az ertesitest: ${RESPONSE}" >&2
    exit 1
    ;;
esac
