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

# WHERE THE MAIN CHANNEL'S STATE LIVES. Neither the bot token nor the owner
# chat id has to be in the project .env: channels.sh deliberately does not
# export the token (so it cannot leak into the tmux environment), and the
# plugin keeps both in its own state directory, mode 600.
#
# Resolution order is NOT invented here -- it is the one src/channel-provider.ts
# (resolveMainChannelStateDir) already defines, mapped to shell the same way
# scripts/unit-fail-notify.sh does it:
#   1. <PROVIDER>_STATE_DIR -- the value the plugin itself runs with, so when it
#      is set it is authoritative for every reader in this process;
#   2. install-scoped <install>/.claude/channels/<provider> while it holds the
#      .env -- the default for migrated and fresh installs;
#   3. legacy $HOME/.claude/channels/<provider> -- only for an install whose
#      channels.sh has not migrated yet.
#
# CLAUDE_CONFIG_DIR is deliberately NOT used: it points at the CALLING agent's
# config directory, and by design that directory never holds the MAIN channel's
# token. Measured 2026-09-21 by the upstream reviewer: resolving through it
# landed on a path that does not exist from a plain shell, and on the calling
# agent's own directory from inside a session -- silent in exactly the
# situation this fallback was written for.
CHANNEL_PROVIDER=$(grep '^CHANNEL_PROVIDER=' "$ENV_FILE" | head -1 | cut -d= -f2-)
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
_PROV_UPPER=$(printf '%s' "$CHANNEL_PROVIDER" | tr '[:lower:]' '[:upper:]')
eval "CHAN_DIR=\${${_PROV_UPPER}_STATE_DIR:-}"
if [ -z "$CHAN_DIR" ]; then
  CHAN_DIR="$PROJECT_DIR/.claude/channels/$CHANNEL_PROVIDER"
  [ -f "$CHAN_DIR/.env" ] || CHAN_DIR="$HOME/.claude/channels/$CHANNEL_PROVIDER"
fi
CHAN_ENV="$CHAN_DIR/.env"
CHAN_ACCESS="$CHAN_DIR/access.json"

if [ -z "$TOKEN" ] && [ -r "$CHAN_ENV" ]; then
  TOKEN=$(grep "^${_PROV_UPPER}_BOT_TOKEN=" "$CHAN_ENV" | head -1 | cut -d= -f2-)
fi

if [ -z "$TOKEN" ]; then
  echo "Hiba: nincs bot-token (sem a projekt .env-ben, sem itt: $CHAN_ENV)"
  exit 1
fi

# CHATID0: "0" is the installer placeholder, not a chat. Without this the
# FALLBACK channel fails exactly where it is needed most -- it fires when the
# plugin is down, and on a placeholder install it would post to chat_id=0.
#
# The placeholder must not END the send, only the .env branch of it.
# src/owner-chat.ts (resolveOwnerChatId) already falls back to the channel's own
# access.json -- the same allowlist the plugin enforces inbound, so a resolved
# id is deliverable by construction -- but this shell copy kept the old
# "exit 1", and that is the one the reauth-healer calls.
#
# MEASURED 2026-09-20 on THIS install, not a claim about yours: ALLOWED_CHAT_ID
# was 0, access.json allowFrom held the paired id, and dashboard.log carried
# "reauth-healer: notify.sh escalation failed" -- the dead-token alarm had no
# way out while the session was wedged. Where .env carries a real id this branch
# never runs.
#
# Deliberately NOT fixed by writing the id into .env: memories.chat_id is
# written AND filtered with ALLOWED_CHAT_ID, so changing it would orphan every
# existing memory (owner-chat.ts spells this out).
if [ -z "$CHAT_ID" ] || [ "$CHAT_ID" = "0" ]; then
  CHAT_ID=$(ACCESS="$CHAN_ACCESS" python3 - <<'PYEOF' 2>/dev/null
import json, os
try:
    raw = json.load(open(os.environ['ACCESS'], encoding='utf-8'))
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
PYEOF
)
fi

if [ -z "$CHAT_ID" ] || [ "$CHAT_ID" = "0" ]; then
  echo "Hiba: nincs gazda-chat (ALLOWED_CHAT_ID nincs beallitva es itt sincs parositott azonosito: $CHAN_ACCESS)"
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
# Test seam (NOTIFYFALLBACK920): the resolution above is the part that breaks
# silently, and it was the part nothing could exercise -- there is no notify
# test in scripts/__tests__ because reaching the send means reaching the real
# Bot API. NOTIFY_RESOLVE_DRYRUN stops here and prints WHAT WAS RESOLVED and
# from WHERE, so the order can be asserted without a network call. It is opt-in
# and never set in production.
if [ -n "${NOTIFY_RESOLVE_DRYRUN:-}" ]; then
  _tok_src="env"
  [ -n "$TOKEN" ] && [ -z "$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)" ] && _tok_src="channel"
  _chat_src="env"
  [ "$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)" = "0" ] && _chat_src="access.json"
  [ -z "$(grep '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)" ] && _chat_src="access.json"
  echo "DRYRUN chan_dir=$CHAN_DIR token_src=$_tok_src chat_id=$CHAT_ID chat_src=$_chat_src"
  exit 0
fi

. "$SCRIPT_DIR/lib/send-telegram.sh"

if send_telegram_message "$TOKEN" "$CHAT_ID" "$MESSAGE" --data-urlencode "parse_mode=HTML"; then
  echo "Ertesites elkuldve."
else
  echo "Hiba: ertesites kuldese sikertelen (reszletek fent)." >&2
  exit 1
fi
