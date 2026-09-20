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

# NOTIFYFALLBACK920, masodik fele: a bot-token sem KELL hogy a projekt .env-jeben
# alljon. Ezen a telepitesen a channels.sh szandekosan NEM exportalja (hogy ne
# szivarogjon a tmux kornyezetebe), a plugin sajat allapotkonyvtara tartja:
# <CLAUDE_CONFIG_DIR>/channels/<provider>/.env (mode 600). Merve 2026-09-20: a
# projekt .env-ben a TELEGRAM_BOT_TOKEN ures, tehat a riaszto-ut token nelkul
# allt. Ugyanaz a forras, ahonnan a chat id is jon, tehat egy helyrol dol el,
# hogy melyik csatornara megy a vesz-ertesites.
if [ -z "$TOKEN" ]; then
  _provider=$(grep '^CHANNEL_PROVIDER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  _provider="${_provider:-telegram}"
  _chan_env="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/${_provider}/.env"
  if [ -r "$_chan_env" ]; then
    _key=$(printf '%s' "$_provider" | tr '[:lower:]' '[:upper:]')_BOT_TOKEN
    TOKEN=$(grep "^${_key}=" "$_chan_env" | head -1 | cut -d= -f2-)
  fi
fi

if [ -z "$TOKEN" ]; then
  echo "Hiba: nincs bot-token (sem a projekt .env-ben, sem a csatorna allapotkonyvtaraban)"
  exit 1
fi

# CHATID0: "0" is the installer placeholder, not a chat. Without this the
# FALLBACK channel fails exactly where it is needed most -- it fires when the
# plugin is down, and on a placeholder install it would post to chat_id=0.
#
# NOTIFYFALLBACK920: the placeholder must not END the send, only the .env
# branch of it. src/owner-chat.ts (resolveOwnerChatId) already falls back to the
# channel's own access.json -- the same allowlist the plugin enforces inbound,
# so a resolved id is deliverable by construction -- but this shell copy kept
# the old "exit 1", and that is the one the reauth-healer calls. Measured
# 2026-09-20 on this host: ALLOWED_CHAT_ID=0, access.json allowFrom=[<paired>],
# and dashboard.log carries "reauth-healer: notify.sh escalation failed" -- the
# dead-token alarm had no way out while the session was wedged. Deliberately NOT
# fixed by writing the id into .env: memories.chat_id is written AND filtered
# with ALLOWED_CHAT_ID, so changing it would orphan every existing memory
# (owner-chat.ts spells this out).
if [ -z "$CHAT_ID" ] || [ "$CHAT_ID" = "0" ]; then
  _provider=$(grep '^CHANNEL_PROVIDER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  _provider="${_provider:-telegram}"
  CHAT_ID=$(CFGDIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" PROV="$_provider" python3 - <<'PY' 2>/dev/null
import json, os
path = os.path.join(os.environ['CFGDIR'], 'channels', os.environ['PROV'], 'access.json')
try:
    raw = json.load(open(path, encoding='utf-8'))
except Exception:
    raise SystemExit(0)
def ok(v):
    v = str(v).strip()
    return v if v and v != '0' else None
for entry in raw.get('allowFrom') or []:
    if ok(entry):
        print(ok(entry)); raise SystemExit(0)
for key in ('groups', 'channels'):
    m = raw.get(key)
    if isinstance(m, dict):
        for k in m:
            if ok(k):
                print(ok(k)); raise SystemExit(0)
PY
)
fi

if [ -z "$CHAT_ID" ] || [ "$CHAT_ID" = "0" ]; then
  echo "Hiba: nincs gazda-chat (ALLOWED_CHAT_ID nincs beallitva es a csatorna access.json sem ad parositott azonositot)"
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
# channel, used exactly when the primary Telegram plugin is already down. The
# success contract (curl exit 0 AND Bot API "ok":true, loud stderr otherwise,
# token redacted) lives in the shared library so every sender speaks the same
# truth (NOTIFYVAKSWEEP826) -- this script consumes it, it no longer inlines it.
. "$SCRIPT_DIR/lib/send-telegram.sh"

if send_telegram_message "$TOKEN" "$CHAT_ID" "$MESSAGE" --data-urlencode "parse_mode=HTML"; then
  echo "Ertesites elkuldve."
else
  echo "Hiba: ertesites kuldese sikertelen (reszletek fent)." >&2
  exit 1
fi
