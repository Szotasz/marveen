#!/usr/bin/env bash
# agent-msg-done.sh -- close an inter-agent message with the homoglyph gate IN
# THE PATH of the write. The sibling of agent-msg.sh, for the other direction.
#
# WHY THIS EXISTS (measured 2026-10-09). The fleet's homoglyph rule ran on six
# routes -- drafts, card comments, memories, reports, handoffs, and POST
# /api/messages via agent-msg.sh -- and not on the seventh: the CLOSING payload,
# `PUT /api/messages/<id>` with a prose `result`. Every CLAUDE.md example writes
# that one inline:
#     curl ... --data-binary '{"status":"done","result":"..."}'
# Inline text never becomes a file, so it never passes a file-based check. The
# support agent found this in its own session after a Cyrillic U+0435 reached a
# `result`, and fixed it by promising to write the payload to a file first. That
# is a habit, and habits are what this repo keeps measuring as the thing that
# lapses (see the agent-msg.sh header: an agent who BUILT such a guard spent a
# day calling the raw route beside it). So the fix is a route, not a rule.
#
# The second half of the same measurement: scripts/homoglyph-sweep.py, the tool
# that would have CAUGHT this, selected only `content` from agent_messages and
# never looked at `result`. Both halves were patched the same day. The first
# sweep that included `result` found exactly one contaminated row.
#
# A RECEIPT CANNOT BE UNSENT. Closing with notify:true generates an `[Eredmény]`
# message to the original sender, carrying a COPY of the result text, and
# message content has no edit endpoint. Fixing the row afterwards does not fix
# the receipt -- one row still stands contaminated for that reason. This is why
# the gate has to run BEFORE the PUT and not as a cleanup after it.
#
# Usage:
#   bash scripts/agent-msg-done.sh <id> <status> [result]      # result: text, - for STDIN, omit for none
#   bash scripts/agent-msg-done.sh <id> <status> - --no-notify < result.txt
# status: done | failed
# --no-notify  -> "notify": false. Use for an INCOMING REPORT or NOTICE, where
#   the sender is not waiting on an answer; the receipt would only grow their
#   queue. Omit it for a DELEGATED TASK, where the receipt IS the answer.
# Output: success -> "OK id=<n> status=<s>"; failure -> "FAIL ..." , exit 1.
#
# Env: same as agent-msg.sh (MARVEEN_API_BASE, MARVEEN_WEB_PORT,
#      MARVEEN_TOKEN_FILE, MARVEEN_HOMOGLYPH_BIN).
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
API_BASE="${MARVEEN_API_BASE:-http://localhost:${PORT}}"
API_BASE="${API_BASE%/}"
TOKEN_FILE="${MARVEEN_TOKEN_FILE:-$BASE/store/.dashboard-token}"
LOG="$BASE/store/agent-msg-failures.log"

ID="${1:?message id required}"
STATUS="${2:?status required (done|failed)}"
RESULT=""
NOTIFY="true"
shift 2
for a in "$@"; do
  case "$a" in
    --no-notify) NOTIFY="false" ;;
    -)  RESULT="$(cat)" ;;
    *)  RESULT="$a" ;;
  esac
done

case "$STATUS" in
  done|failed) : ;;
  *) echo "FAIL: status must be done or failed (got '$STATUS')" >&2; exit 2 ;;
esac
case "$ID" in
  ''|*[!0-9]*) echo "FAIL: id must be numeric (got '$ID')" >&2; exit 2 ;;
esac
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE" >&2; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"
URL="${API_BASE}/api/messages/${ID}"

# --- Homoglyph gate, on the RAW result text, BEFORE the payload is built ----
# Same reasoning as agent-msg.sh: json.dumps turns a Cyrillic letter into
# \uXXXX, so a checker reading the encoded body no longer sees a letter. And
# the same fail-open-but-loud exception: a missing checker must not block the
# fleet's mandated close route, because that would be a NEW failure.
if [ -n "$RESULT" ]; then
  HG="${MARVEEN_HOMOGLYPH_BIN:-$BASE/scripts/lib/homoglyph.py}"
  if [ -r "$HG" ] && command -v python3 >/dev/null 2>&1; then
    # Exit code only -- never the checker's stdout. A checker that exits 0 with
    # empty stdout would otherwise blank the result field and report success.
    printf '%s' "$RESULT" | python3 "$HG" >/dev/null
    HG_RC=$?
    case "$HG_RC" in
      0) : ;;
      3) echo "FAIL: homoglyph gate refused the result; the message was NOT closed." >&2
         exit 3 ;;
      *) echo "FAIL: homoglyph checker CRASHED (rc=$HG_RC) at $HG; the message was NOT closed." >&2
         echo "  This is not a verdict on the text -- fix or unset MARVEEN_HOMOGLYPH_BIN." >&2
         exit 4 ;;
    esac
  else
    echo "WARN: homoglyph checker not found at $HG -- closing UNCHECKED." >&2
  fi
fi

# notify must be a real JSON boolean: the string "false" gets a 400 AND the
# close does not happen (CLAUDE.md, measured). json.dumps keeps it a boolean.
BODY="$(STATUS="$STATUS" RESULT="$RESULT" NOTIFY="$NOTIFY" python3 -c '
import json, os
b = {"status": os.environ["STATUS"], "notify": os.environ["NOTIFY"] == "true"}
r = os.environ["RESULT"]
if r:
    b["result"] = r
print(json.dumps(b))')"

attempt=0; max=3; CODE=""; JSON=""
while [ "$attempt" -lt "$max" ]; do
  attempt=$((attempt+1))
  RESP="$(curl -s -X PUT "$URL" -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" --data-binary "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
  CODE="$(printf '%s' "$RESP" | tail -n1)"
  JSON="$(printf '%s' "$RESP" | sed '$d')"
  if [ "$CODE" = "200" ]; then
    # Read the status BACK from the response rather than trusting the 200: the
    # same lesson as agent-msg.sh reading the id instead of curl's exit code.
    GOT="$(printf '%s' "$JSON" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  if not isinstance(d,dict): d={}
except Exception:
  d={}
print(d.get("status") or (d.get("message") or {}).get("status") or "")' 2>/dev/null)"
    if [ -z "$GOT" ] || [ "$GOT" = "$STATUS" ]; then
      echo "OK id=$ID status=$STATUS notify=$NOTIFY"
      exit 0
    fi
    echo "FAIL id=$ID http=200 but status came back '$GOT', expected '$STATUS'" >&2
    exit 1
  fi
  sleep 1
done
echo "FAIL id=$ID url=$URL http=${CODE:-?} (after $max tries)"
printf '%s\tFAIL\tclose=%s\turl=%s\thttp=%s\tresp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$ID" "$URL" "${CODE:-?}" "$(printf '%s' "${JSON:-}" | head -c 200)" >> "$LOG" 2>/dev/null || true
exit 1
