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
POLL_MAX=30
PASS=0
FAIL=0

log() { echo "[smoke-test] $*"; }
fail() { log "FAIL: $*"; FAIL=$((FAIL + 1)); }
pass() { log "OK: $*"; PASS=$((PASS + 1)); }
redact() { sed 's/xoxb-[A-Za-z0-9_-]*/xoxb-REDACTED/g; s/xapp-[A-Za-z0-9_-]*/xapp-REDACTED/g'; }

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
  DM_OK="$(echo "$OPEN_RESP" | python3 -c "import json,sys; print(str(json.load(sys.stdin).get('ok','')).lower())" 2>/dev/null || true)"
  if [ "$DM_OK" != "true" ]; then
    fail "conversations.open sikertelen: $(echo "$OPEN_RESP" | redact)"
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
  MSG_OK="$(echo "$MSG_RESP" | python3 -c "import json,sys; print(str(json.load(sys.stdin).get('ok','')).lower())" 2>/dev/null || true)"
  if [ "$MSG_OK" != "true" ]; then
    fail "chat.postMessage sikertelen: $(echo "$MSG_RESP" | redact)"
    exit 1
  fi
  log "Üzenet elküldve: $RANDOM_ID"
fi

# Poll for plugin to process (early exit on match, max POLL_MAX seconds)
if [ "$DRY_RUN" = "1" ]; then
  log "[DRY-RUN] Várakozás kihagyva"
  POLL_HIT=0
else
  log "Polling audit.jsonl-t max ${POLL_MAX}s..."
  POLL_HIT=0
  for i in $(seq 1 "$POLL_MAX"); do
    if [ -f "$AUDIT_FILE" ]; then
      NEW_LINES="$(tail -c +"$((AUDIT_BEFORE + 1))" "$AUDIT_FILE" 2>/dev/null || true)"
      if echo "$NEW_LINES" | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        entry = json.loads(line)
        if entry.get('kind') == 'gate.inbound.deliver':
            sys.exit(0)
    except: pass
sys.exit(1)
" 2>/dev/null; then
        POLL_HIT=1
        log "gate.inbound.deliver megjelent ${i}s utan"
        break
      fi
    fi
    sleep 1
  done
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

# Check 2: audit.jsonl has gate.inbound.deliver entry
if [ "$DRY_RUN" = "1" ]; then
  pass "Audit.jsonl ellenőrzés (dry-run: kihagyva)"
else
  if [ "$POLL_HIT" = "1" ]; then
    pass "Audit.jsonl tartalmaz gate.inbound.deliver bejegyzést"
  else
    fail "Audit.jsonl-ben NEM jelent meg gate.inbound.deliver bejegyzés ${POLL_MAX}s alatt"
  fi
fi

# Summary
echo ""
log "Eredmény: $PASS OK, $FAIL FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
