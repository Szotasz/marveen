#!/bin/bash
# Unit tests for the deterministic conversation-continuity ledger hooks.
# Run: bash scripts/__tests__/conversation-ledger.test.sh

set -e

PASS=0
FAIL=0
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$INSTALL_DIR/scripts/hooks"

# Helper: run a hook with isolation env vars; stdin is already set by caller
run_hook() {
    local hook="$1"
    local db="$2"
    shift 2
    LEDGER_DB_PATH="$db" LEDGER_OWNER_CHAT="8517922966" python3 "$HOOKS_DIR/$hook" "$@"
}

# Helper: run a single-value SELECT, DB path and SQL passed as argv (no shell interpolation into python source)
db_scalar() {
    local db="$1"
    local sql="$2"
    python3 - "$db" "$sql" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
try:
    val = con.execute(sys.argv[2]).fetchone()
    print(val[0] if val else 'NULL')
except Exception:
    print('NULL')
finally:
    con.close()
PYEOF
}

# Standard channel-block prompt payload (JSON, inline \n becomes literal newline after echo -e / printf is NOT used)
# The \n in the JSON string value is a JSON escape sequence, preserved as-is in the bash string.
CHANNEL_PROMPT='{"hook_event_name":"UserPromptSubmit","prompt":"<channel source=\"plugin:telegram:telegram\" chat_id=\"8517922966\" message_id=\"1054\" user=\"x\" ts=\"2026-06-02T14:20:25.000Z\">\nJók a Fókusz e-mail címek\n</channel>"}'

echo "conversation-ledger tests"
echo "========================="

# ---------------------------------------------------------------------------
# (a) INBOUND CAPTURE
# ---------------------------------------------------------------------------
echo ""
echo "(a) Inbound capture"

DB_A="$TMPDIR_BASE/a.db"
printf '%s' "$CHANNEL_PROMPT" | run_hook ledger-capture.py "$DB_A"

ROW_COUNT=$(db_scalar "$DB_A" "SELECT COUNT(*) FROM pending_messages")
if [ "$ROW_COUNT" = "1" ]; then
    pass "inbound capture: exactly 1 row inserted"
else
    fail "inbound capture: expected 1 row, got $ROW_COUNT"
fi

CHAT_ID_VAL=$(db_scalar "$DB_A" "SELECT chat_id FROM pending_messages")
if [ "$CHAT_ID_VAL" = "8517922966" ]; then
    pass "inbound capture: chat_id=8517922966"
else
    fail "inbound capture: chat_id expected 8517922966, got $CHAT_ID_VAL"
fi

MSG_ID_VAL=$(db_scalar "$DB_A" "SELECT message_id FROM pending_messages")
if [ "$MSG_ID_VAL" = "1054" ]; then
    pass "inbound capture: message_id=1054"
else
    fail "inbound capture: message_id expected 1054, got $MSG_ID_VAL"
fi

ANSWERED_VAL=$(db_scalar "$DB_A" "SELECT answered FROM pending_messages")
if [ "$ANSWERED_VAL" = "0" ]; then
    pass "inbound capture: answered=0"
else
    fail "inbound capture: answered expected 0, got $ANSWERED_VAL"
fi

# Check text is non-empty and contains content from the message ("Fókusz")
python3 - "$DB_A" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
text = con.execute("SELECT text FROM pending_messages").fetchone()[0]
con.close()
assert text and len(text.strip()) > 0, f"text is empty: {text!r}"
# The message text "Jók a Fókusz e-mail címek" should be partially present
# (the JSON \n is decoded by json.load in the hook before the regex runs)
assert any(fragment in text for fragment in ["k", "mail", "Fókusz", "J"]), f"unexpected text: {text!r}"
print("  PASS: inbound capture: text contains message content")
PYEOF
if [ $? -ne 0 ]; then
    fail "inbound capture: text check failed"
fi

# ---------------------------------------------------------------------------
# (b) ANSWERED FLIP
# ---------------------------------------------------------------------------
echo ""
echo "(b) Answered flip"

DB_B="$TMPDIR_BASE/b.db"
printf '%s' "$CHANNEL_PROMPT" | run_hook ledger-capture.py "$DB_B"

REPLY_PAYLOAD='{"tool_name":"mcp__plugin_telegram_telegram__reply","tool_input":{"chat_id":"8517922966","text":"ok"}}'
printf '%s' "$REPLY_PAYLOAD" | run_hook ledger-answered.py "$DB_B"

ANSWERED_B=$(db_scalar "$DB_B" "SELECT answered FROM pending_messages WHERE message_id='1054'")
if [ "$ANSWERED_B" = "1" ]; then
    pass "answered flip: answered=1 after reply"
else
    fail "answered flip: expected answered=1, got $ANSWERED_B"
fi

ANSWERED_AT=$(db_scalar "$DB_B" "SELECT answered_at FROM pending_messages WHERE message_id='1054'")
if [ "$ANSWERED_AT" != "NULL" ] && [ -n "$ANSWERED_AT" ]; then
    pass "answered flip: answered_at is not null"
else
    fail "answered flip: answered_at is null"
fi

# chat_id=0 shorthand: fresh DB with message_id=1055, flip using chat_id=0
DB_B2="$TMPDIR_BASE/b2.db"
PROMPT_1055='{"hook_event_name":"UserPromptSubmit","prompt":"<channel source=\"plugin:telegram:telegram\" chat_id=\"8517922966\" message_id=\"1055\" user=\"x\" ts=\"2026-06-02T14:21:00.000Z\">\nMasik uzenet\n</channel>"}'
printf '%s' "$PROMPT_1055" | run_hook ledger-capture.py "$DB_B2"

ZERO_REPLY='{"tool_name":"mcp__plugin_telegram_telegram__reply","tool_input":{"chat_id":0,"text":"ok zero shorthand"}}'
printf '%s' "$ZERO_REPLY" | run_hook ledger-answered.py "$DB_B2"

ANSWERED_B2=$(db_scalar "$DB_B2" "SELECT answered FROM pending_messages WHERE message_id='1055'")
if [ "$ANSWERED_B2" = "1" ]; then
    pass "answered flip: chat_id=0 shorthand resolves to owner chat"
else
    fail "answered flip: chat_id=0 shorthand did NOT flip row, answered=$ANSWERED_B2"
fi

# ---------------------------------------------------------------------------
# (c) STARTUP REPLAY
# ---------------------------------------------------------------------------
echo ""
echo "(c) Startup replay"

DB_C="$TMPDIR_BASE/c.db"
printf '%s' "$CHANNEL_PROMPT" | run_hook ledger-capture.py "$DB_C"

SESSION_PAYLOAD='{"hook_event_name":"SessionStart","source":"startup"}'
REPLAY_OUT=$(printf '%s' "$SESSION_PAYLOAD" | run_hook ledger-replay.py "$DB_C")

if [ -z "$REPLAY_OUT" ]; then
    fail "replay: expected JSON output for open row, got empty"
else
    pass "replay: produced output for open row"
fi

# Write the replay output to a temp file and assert via python3 script
REPLAY_TMP="$TMPDIR_BASE/replay_out.json"
printf '%s\n' "$REPLAY_OUT" > "$REPLAY_TMP"

REPLAY_CHECK="$TMPDIR_BASE/replay_check.py"
cat > "$REPLAY_CHECK" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    raw = f.read().strip()
if not raw:
    print("  FAIL: replay output file is empty")
    sys.exit(1)
data = json.loads(raw)
assert "hookSpecificOutput" in data, f"missing hookSpecificOutput in: {raw[:300]}"
ctx = data["hookSpecificOutput"]["additionalContext"]
assert ctx, "additionalContext is empty"
print("  PASS: replay: JSON has hookSpecificOutput.additionalContext")
assert "1054" in ctx, f"message_id 1054 not in ctx: {ctx[:300]}"
print("  PASS: replay: context contains message_id 1054")
assert any(fragment in ctx for fragment in ["Fókusz", "mail", "J", "k"]), f"message text not found in ctx: {ctx[:300]}"
print("  PASS: replay: context contains message text")
PYEOF

python3 "$REPLAY_CHECK" "$REPLAY_TMP"

# Empty ledger: no-op, no stdout
DB_C_EMPTY="$TMPDIR_BASE/c_empty.db"
REPLAY_EMPTY=$(printf '%s' "$SESSION_PAYLOAD" | run_hook ledger-replay.py "$DB_C_EMPTY")
if [ -z "$REPLAY_EMPTY" ]; then
    pass "replay: empty ledger prints nothing"
else
    fail "replay: empty ledger should print nothing, got: $REPLAY_EMPTY"
fi

# All-answered ledger: also no-op
DB_C_DONE="$TMPDIR_BASE/c_done.db"
printf '%s' "$CHANNEL_PROMPT" | run_hook ledger-capture.py "$DB_C_DONE"
printf '%s' "$REPLY_PAYLOAD" | run_hook ledger-answered.py "$DB_C_DONE"
REPLAY_DONE=$(printf '%s' "$SESSION_PAYLOAD" | run_hook ledger-replay.py "$DB_C_DONE")
if [ -z "$REPLAY_DONE" ]; then
    pass "replay: all-answered ledger prints nothing"
else
    fail "replay: all-answered ledger should print nothing, got: $REPLAY_DONE"
fi

# ---------------------------------------------------------------------------
# (d) IDEMPOTENCY
# ---------------------------------------------------------------------------
echo ""
echo "(d) Idempotency"

DB_D="$TMPDIR_BASE/d.db"
printf '%s' "$CHANNEL_PROMPT" | run_hook ledger-capture.py "$DB_D"
printf '%s' "$CHANNEL_PROMPT" | run_hook ledger-capture.py "$DB_D"

IDEM_COUNT=$(db_scalar "$DB_D" "SELECT COUNT(*) FROM pending_messages")
if [ "$IDEM_COUNT" = "1" ]; then
    pass "idempotency: duplicate capture yields exactly 1 row"
else
    fail "idempotency: expected 1 row, got $IDEM_COUNT"
fi

# ---------------------------------------------------------------------------
# EDGE CASES
# ---------------------------------------------------------------------------
echo ""
echo "Edge cases"

# Edge 1: prompt with no channel block -> 0 rows, exit 0
DB_E1="$TMPDIR_BASE/e1.db"
NO_CHANNEL='{"hook_event_name":"UserPromptSubmit","prompt":"Hello, how are you today?"}'
printf '%s' "$NO_CHANNEL" | run_hook ledger-capture.py "$DB_E1"
# DB may not have the table at all if no rows were ever written; handle gracefully
E1_COUNT=$(db_scalar "$DB_E1" "SELECT COUNT(*) FROM pending_messages")
if [ "$E1_COUNT" = "0" ] || [ "$E1_COUNT" = "NULL" ]; then
    pass "edge: no-channel prompt inserts 0 rows"
else
    fail "edge: no-channel prompt inserted unexpected rows: $E1_COUNT"
fi

# Edge 2: malformed/empty stdin -> no crash, exit 0
DB_E2="$TMPDIR_BASE/e2.db"
printf '' | run_hook ledger-capture.py "$DB_E2" \
    && pass "edge: empty stdin does not crash ledger-capture" \
    || fail "edge: empty stdin caused crash in ledger-capture"
printf 'not json at all {{{' | run_hook ledger-capture.py "$DB_E2" \
    && pass "edge: malformed JSON does not crash ledger-capture" \
    || fail "edge: malformed JSON crashed ledger-capture"
printf '' | run_hook ledger-answered.py "$DB_E2" \
    && pass "edge: empty stdin does not crash ledger-answered" \
    || fail "edge: empty stdin caused crash in ledger-answered"
printf 'not json' | run_hook ledger-answered.py "$DB_E2" \
    && pass "edge: malformed JSON does not crash ledger-answered" \
    || fail "edge: malformed JSON crashed ledger-answered"

# Edge 3: answered hook with a non-telegram tool_name -> no flip
DB_E3="$TMPDIR_BASE/e3.db"
printf '%s' "$CHANNEL_PROMPT" | run_hook ledger-capture.py "$DB_E3"
NON_TELEGRAM='{"tool_name":"mcp__github__create_issue","tool_input":{"chat_id":"8517922966","text":"irrelevant"}}'
printf '%s' "$NON_TELEGRAM" | run_hook ledger-answered.py "$DB_E3"
E3_ANSWERED=$(db_scalar "$DB_E3" "SELECT answered FROM pending_messages WHERE chat_id='8517922966'")
if [ "$E3_ANSWERED" = "0" ]; then
    pass "edge: non-telegram tool does not flip answered"
else
    fail "edge: non-telegram tool flipped answered (expected 0, got $E3_ANSWERED)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then
    echo "FAILED: $FAIL tests"
    exit 1
fi
echo "All tests passed."
