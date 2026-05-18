#!/bin/bash
# Slack channel plugin smoke-test.
# Sends a DM via the Slack API and verifies that the plugin picked it up
# (new session file + audit.jsonl entry).
#
# Usage:  ./scripts/smoke-test-slack-channel.sh [agent-name]
# Exit:   0 = OK, 1 = broken
#
# Env flags:
#   SLACK_SMOKE_TEST_ALLOWED=true   required (safety gate)
#   SMOKE_TEST_DRY_RUN=1            skip actual Slack API calls, log what would happen

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT="${1:-slacker}"
STATE_DIR="$INSTALL_DIR/agents/$AGENT/.claude/channels/slack"
ENV_FILE="$STATE_DIR/.env"
ACCESS_FILE="$STATE_DIR/access.json"
AUDIT_FILE="$STATE_DIR/audit.jsonl"
DRY_RUN="${SMOKE_TEST_DRY_RUN:-0}"
WAIT_SECONDS=15
PASS=0
FAIL=0

log() { echo "[smoke-test] $*"; }
fail() { log "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { log "OK: $*"; PASS=$((PASS + 1)); }

# Safety gate
if [ "${SLACK_SMOKE_TEST_ALLOWED:-}" != "true" ]; then
  log "SLACK_SMOKE_TEST_ALLOWED != true. Állítsd be a .env-ben a teszteléshez."
  exit 1
fi

# Read bot token
if [ ! -f "$ENV_FILE" ]; then
  log "Nem található: $ENV_FILE"
  exit 1
fi
SLACK_BOT_TOKEN="$(grep '^SLACK_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
if [ -z "$SLACK_BOT_TOKEN" ]; then
  log "SLACK_BOT_TOKEN üres az $ENV_FILE-ben."
  exit 1
fi

# Read first allowed user from access.json
if [ ! -f "$ACCESS_FILE" ]; then
  log "Nem található: $ACCESS_FILE"
  exit 1
fi
USER_ID="$(python3 -c "import json,sys; d=json.load(open('$ACCESS_FILE')); print((d.get('allowFrom') or [''])[0])" 2>/dev/null || true)"
if [ -z "$USER_ID" ]; then
  log "Nincs allowFrom user az access.json-ben."
  exit 1
fi

log "Agent: $AGENT | User: $USER_ID"

# Open DM channel
if [ "$DRY_RUN" = "1" ]; then
  log "[DRY-RUN] conversations.open user=$USER_ID"
  DM_CHANNEL="DRY_RUN_CHANNEL"
else
  OPEN_RESP="$(curl -sf -X POST 'https://slack.com/api/conversations.open' \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"users\":\"$USER_ID\"}" 2>/dev/null || true)"
  DM_OK="$(echo "$OPEN_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || true)"
  if [ "$DM_OK" != "True" ]; then
    fail "conversations.open sikertelen: $OPEN_RESP"
    exit 1
  fi
  DM_CHANNEL="$(echo "$OPEN_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['channel']['id'])" 2>/dev/null)"
fi
log "DM channel: $DM_CHANNEL"

# Snapshot session dir mtime
SESSION_DIR="$STATE_DIR/sessions/$DM_CHANNEL"
if [ -d "$SESSION_DIR" ]; then
  BEFORE_COUNT="$(find "$SESSION_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')"
else
  BEFORE_COUNT=0
fi

# Snapshot audit.jsonl size
if [ -f "$AUDIT_FILE" ]; then
  AUDIT_BEFORE="$(wc -c < "$AUDIT_FILE" | tr -d ' ')"
else
  AUDIT_BEFORE=0
fi

# Send smoke-test message
RANDOM_ID="smoke-$(date +%s)-$$"
if [ "$DRY_RUN" = "1" ]; then
  log "[DRY-RUN] chat.postMessage channel=$DM_CHANNEL text=$RANDOM_ID"
else
  MSG_RESP="$(curl -sf -X POST 'https://slack.com/api/chat.postMessage' \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"channel\":\"$DM_CHANNEL\",\"text\":\"$RANDOM_ID\"}" 2>/dev/null || true)"
  MSG_OK="$(echo "$MSG_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null || true)"
  if [ "$MSG_OK" != "True" ]; then
    fail "chat.postMessage sikertelen: $MSG_RESP"
    exit 1
  fi
  log "Üzenet elküldve: $RANDOM_ID"
fi

# Wait for plugin to process
if [ "$DRY_RUN" = "1" ]; then
  log "[DRY-RUN] Várakozás kihagyva"
else
  log "Várakozás ${WAIT_SECONDS}s..."
  sleep "$WAIT_SECONDS"
fi

# Check 1: new session file
if [ "$DRY_RUN" = "1" ]; then
  pass "Session fájl ellenőrzés (dry-run: kihagyva)"
else
  if [ -d "$SESSION_DIR" ]; then
    AFTER_COUNT="$(find "$SESSION_DIR" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')"
  else
    AFTER_COUNT=0
  fi
  if [ "$AFTER_COUNT" -gt "$BEFORE_COUNT" ]; then
    pass "Új session fájl megjelent ($BEFORE_COUNT -> $AFTER_COUNT)"
  else
    fail "Nem jelent meg új session fájl ($BEFORE_COUNT -> $AFTER_COUNT)"
  fi
fi

# Check 2: audit.jsonl grew
if [ "$DRY_RUN" = "1" ]; then
  pass "Audit.jsonl ellenőrzés (dry-run: kihagyva)"
else
  if [ -f "$AUDIT_FILE" ]; then
    AUDIT_AFTER="$(wc -c < "$AUDIT_FILE" | tr -d ' ')"
  else
    AUDIT_AFTER=0
  fi
  if [ "$AUDIT_AFTER" -gt "$AUDIT_BEFORE" ]; then
    pass "Audit.jsonl bővült ($AUDIT_BEFORE -> $AUDIT_AFTER bytes)"
  else
    fail "Audit.jsonl nem bővült ($AUDIT_BEFORE -> $AUDIT_AFTER bytes)"
  fi
fi

# Summary
echo ""
log "Eredmény: $PASS OK, $FAIL FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
