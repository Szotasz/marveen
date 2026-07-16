#!/bin/bash
# Unit tests for the deterministic conversation-continuity ledger hooks.
#
# Architecture under test (increment 2 -- CONTEXT WINDOW): a single rolling
# transcript table `conversation_log` (direction in/out) is the SOLE source of
# truth. ledger-capture.py records inbound user turns (direction='in'),
# ledger-outbound.py records the agent's replies (direction='out'), and
# ledger-replay.py injects the last N turns of context (chronological, prefixed)
# PLUS a highlighted open question (the most recent inbound with no later
# outbound). agent_id is derived from the session cwd so each agent only ever
# sees its OWN chat.
#
# Run: bash scripts/__tests__/conversation-ledger.test.sh

set -e

PASS=0
FAIL=0
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$INSTALL_DIR/scripts/hooks"

# Run a hook with isolation env vars. MAIN_AGENT_ID is pinned so a payload with
# no cwd resolves deterministically to agent 'marveen'. Extra env (e.g.
# LEDGER_CONTEXT_WINDOW=3) can be exported by the caller and is inherited.
run_hook() {
    local hook="$1"
    local db="$2"
    shift 2
    LEDGER_DB_PATH="$db" LEDGER_OWNER_CHAT="8517922966" MAIN_AGENT_ID="marveen" \
        python3 "$HOOKS_DIR/$hook" "$@"
}

# Run the live-drain from cwd=INSTALL_DIR so agent_id resolves to 'marveen'
# (matching the capture/outbound rows). The drain's dedup statefile lands beside
# the DB (dirname of LEDGER_DB_PATH), so per-case subdirs keep it isolated.
run_drain() { # db
    ( cd "$INSTALL_DIR" && LEDGER_DB_PATH="$1" LEDGER_OWNER_CHAT="8517922966" \
        MAIN_AGENT_ID="marveen" python3 "$HOOKS_DIR/ledger-live-drain.py" )
}

# Age every row in a ledger DB backwards so an open question clears the grace window.
age_rows() { # db seconds
    python3 - "$1" "$2" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("UPDATE conversation_log SET created_at = created_at - ?", (int(sys.argv[2]),))
con.commit(); con.close()
PYEOF
}

# Single-value SELECT; DB path and SQL passed as argv (no shell interpolation
# into python source). Missing table / no row -> 'NULL'.
db_scalar() {
    python3 - "$1" "$2" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
try:
    val = con.execute(sys.argv[2]).fetchone()
    print(val[0] if val and val[0] is not None else 'NULL')
except Exception:
    print('NULL')
finally:
    con.close()
PYEOF
}

# Emit an inbound UserPromptSubmit payload (JSON built in python -> no escaping pain).
emit_inbound() { # chat_id message_id text [cwd]
    python3 - "$@" <<'PYEOF'
import json, sys
chat_id, message_id, text = sys.argv[1], sys.argv[2], sys.argv[3]
block = (f'<channel source="plugin:telegram:telegram" chat_id="{chat_id}" '
         f'message_id="{message_id}" user="x" ts="2026-06-02T14:20:25.000Z">\n{text}\n</channel>')
payload = {"hook_event_name": "UserPromptSubmit", "prompt": block}
if len(sys.argv) > 4:
    payload["cwd"] = sys.argv[4]
print(json.dumps(payload))
PYEOF
}

# Emit a Telegram reply PostToolUse payload.
emit_reply() { # chat_id text [cwd]
    python3 - "$@" <<'PYEOF'
import json, sys
payload = {"tool_name": "mcp__plugin_telegram_telegram__reply",
           "tool_input": {"chat_id": sys.argv[1], "text": sys.argv[2]}}
if len(sys.argv) > 3:
    payload["cwd"] = sys.argv[3]
print(json.dumps(payload))
PYEOF
}

# Emit a SessionStart payload.
emit_session() { # [cwd]
    python3 - "$@" <<'PYEOF'
import json, sys
payload = {"hook_event_name": "SessionStart", "source": "startup"}
if len(sys.argv) > 1:
    payload["cwd"] = sys.argv[1]
print(json.dumps(payload))
PYEOF
}

# Extract hookSpecificOutput.additionalContext from a replay JSON blob (file).
# Empty / no output -> prints nothing.
ctx_of() {
    python3 - "$1" <<'PYEOF'
import json, sys
try:
    raw = open(sys.argv[1]).read().strip()
    if not raw:
        sys.exit(0)
    print(json.loads(raw)["hookSpecificOutput"]["additionalContext"])
except Exception:
    sys.exit(0)
PYEOF
}

echo "conversation-ledger tests"
echo "========================="

# ---------------------------------------------------------------------------
# (a) INBOUND CAPTURE -> conversation_log direction='in'
# ---------------------------------------------------------------------------
echo ""
echo "(a) Inbound capture"

DB_A="$TMPDIR_BASE/a.db"
emit_inbound 8517922966 1054 "Jok a Fokusz e-mail cimek" | run_hook ledger-capture.py "$DB_A"

assert_eq "inbound capture: exactly 1 row" "1" \
    "$(db_scalar "$DB_A" "SELECT COUNT(*) FROM conversation_log")"
assert_eq "inbound capture: direction='in'" "in" \
    "$(db_scalar "$DB_A" "SELECT direction FROM conversation_log")"
assert_eq "inbound capture: chat_id" "8517922966" \
    "$(db_scalar "$DB_A" "SELECT chat_id FROM conversation_log")"
assert_eq "inbound capture: message_id" "1054" \
    "$(db_scalar "$DB_A" "SELECT message_id FROM conversation_log")"
assert_eq "inbound capture: text recorded" "Jok a Fokusz e-mail cimek" \
    "$(db_scalar "$DB_A" "SELECT text FROM conversation_log")"

# ---------------------------------------------------------------------------
# (b) OUTBOUND CAPTURE -> conversation_log direction='out'
# ---------------------------------------------------------------------------
echo ""
echo "(b) Outbound capture"

DB_B="$TMPDIR_BASE/b.db"
emit_inbound 8517922966 1054 "kerdes" | run_hook ledger-capture.py "$DB_B"
emit_reply 8517922966 "ez a valaszom" | run_hook ledger-outbound.py "$DB_B"

assert_eq "outbound: exactly 1 out row" "1" \
    "$(db_scalar "$DB_B" "SELECT COUNT(*) FROM conversation_log WHERE direction='out'")"
assert_eq "outbound: reply text recorded" "ez a valaszom" \
    "$(db_scalar "$DB_B" "SELECT text FROM conversation_log WHERE direction='out'")"
assert_eq "outbound: out row chat_id" "8517922966" \
    "$(db_scalar "$DB_B" "SELECT chat_id FROM conversation_log WHERE direction='out'")"

# chat_id=0 shorthand resolves to the owner chat
DB_B2="$TMPDIR_BASE/b2.db"
emit_reply 0 "valasz nullaval" | run_hook ledger-outbound.py "$DB_B2"
assert_eq "outbound: chat_id=0 shorthand resolves to owner chat" "8517922966" \
    "$(db_scalar "$DB_B2" "SELECT chat_id FROM conversation_log WHERE direction='out'")"

# ---------------------------------------------------------------------------
# (c) STARTUP REPLAY -- context window + open question
# ---------------------------------------------------------------------------
echo ""
echo "(c) Startup replay"

# Open question present: single unanswered inbound
DB_C="$TMPDIR_BASE/c.db"
emit_inbound 8517922966 1054 "Jok a Fokusz cimek" | run_hook ledger-capture.py "$DB_C"
emit_session | run_hook ledger-replay.py "$DB_C" > "$TMPDIR_BASE/c.json"
C_CTX="$(ctx_of "$TMPDIR_BASE/c.json")"
if [ -n "$C_CTX" ]; then pass "replay: produced output for open conversation"; else fail "replay: expected output, got empty"; fi
if printf '%s' "$C_CTX" | grep -q "1054" && printf '%s' "$C_CTX" | grep -q "Fokusz"; then
    pass "replay: context contains the open message (id + text)"
else
    fail "replay: open message not found in context"
fi
if printf '%s' "$C_CTX" | grep -q "NYITOTT KÉRDÉS"; then
    pass "replay: highlights the open (unanswered) question"
else
    fail "replay: missing open-question block"
fi

# Context window is chronological and prefixed (Gyula: / Te:)
DB_CW="$TMPDIR_BASE/cw.db"
emit_inbound 8517922966 1 "ELSO_UZENET"  | run_hook ledger-capture.py  "$DB_CW"
emit_reply   8517922966   "VALASZ_KOZEP" | run_hook ledger-outbound.py "$DB_CW"
emit_inbound 8517922966 2 "MASODIK_UZENET" | run_hook ledger-capture.py "$DB_CW"
emit_session | run_hook ledger-replay.py "$DB_CW" > "$TMPDIR_BASE/cw.json"
CW_CTX="$(ctx_of "$TMPDIR_BASE/cw.json")"
if printf '%s' "$CW_CTX" | grep -q "Gyula:" && printf '%s' "$CW_CTX" | grep -q "Te:"; then
    pass "replay: turns carry Gyula:/Te: prefixes"
else
    fail "replay: missing direction prefixes"
fi
if printf '%s' "$CW_CTX" | python3 -c '
import sys
s = sys.stdin.read()
# The transcript turns live in the "LEGFRISSEBB FORDULOK" section; the newest
# message also appears earlier in the open-question block at the top (the #623
# reorder puts the directive + open question first). Scope the chronological
# check to the transcript section so the open-question echo does not skew it.
i = s.find("LEGFRISSEBB FORDUL")
sec = s[i:] if i != -1 else s
a, b, c = sec.find("ELSO_UZENET"), sec.find("VALASZ_KOZEP"), sec.find("MASODIK_UZENET")
sys.exit(0 if (a != -1 and b != -1 and c != -1 and a < b < c) else 1)
'; then
    pass "replay: context window is in chronological order"
else
    fail "replay: context window not in chronological order"
fi

# Empty ledger -> no output (no-op)
DB_C_EMPTY="$TMPDIR_BASE/c_empty.db"
EMPTY_OUT="$(emit_session | run_hook ledger-replay.py "$DB_C_EMPTY")"
assert_eq "replay: empty ledger prints nothing" "" "$EMPTY_OUT"

# All-answered ledger -> STILL prints transcript context, but NO open-question block
DB_C_DONE="$TMPDIR_BASE/c_done.db"
emit_inbound 8517922966 1054 "regi kerdes" | run_hook ledger-capture.py "$DB_C_DONE"
emit_reply 8517922966 "regi valasz" | run_hook ledger-outbound.py "$DB_C_DONE"
emit_session | run_hook ledger-replay.py "$DB_C_DONE" > "$TMPDIR_BASE/c_done.json"
DONE_CTX="$(ctx_of "$TMPDIR_BASE/c_done.json")"
if [ -n "$DONE_CTX" ]; then
    pass "replay: answered ledger still replays transcript context"
else
    fail "replay: answered ledger should still replay context"
fi
if printf '%s' "$DONE_CTX" | grep -q "NYITOTT KÉRDÉS"; then
    fail "replay: answered ledger must NOT show an open-question block"
else
    pass "replay: answered ledger has no open-question block"
fi

# ---------------------------------------------------------------------------
# (d) N-LIMIT -- LEDGER_CONTEXT_WINDOW caps the number of replayed turns
# ---------------------------------------------------------------------------
echo ""
echo "(d) Context-window N-limit"

DB_N="$TMPDIR_BASE/n.db"
for i in 1 2 3 4 5; do
    emit_inbound 8517922966 "$i" "MSG_NUM_${i}" | run_hook ledger-capture.py "$DB_N"
done
LEDGER_CONTEXT_WINDOW=3 run_hook ledger-replay.py "$DB_N" < <(emit_session) > "$TMPDIR_BASE/n.json"
N_CTX="$(ctx_of "$TMPDIR_BASE/n.json")"
if printf '%s' "$N_CTX" | grep -q "MSG_NUM_5" && printf '%s' "$N_CTX" | grep -q "MSG_NUM_3"; then
    pass "replay: N-limit keeps the most recent turns"
else
    fail "replay: N-limit dropped a recent turn it should have kept"
fi
if printf '%s' "$N_CTX" | grep -q "MSG_NUM_1" || printf '%s' "$N_CTX" | grep -q "MSG_NUM_2"; then
    fail "replay: N-limit did not drop the oldest turns"
else
    pass "replay: N-limit drops turns beyond the window"
fi

# ---------------------------------------------------------------------------
# (e) IDEMPOTENCY -- duplicate inbound capture yields one row
# ---------------------------------------------------------------------------
echo ""
echo "(e) Idempotency"

DB_D="$TMPDIR_BASE/d.db"
emit_inbound 8517922966 1054 "ugyanaz" | run_hook ledger-capture.py "$DB_D"
emit_inbound 8517922966 1054 "ugyanaz" | run_hook ledger-capture.py "$DB_D"
assert_eq "idempotency: duplicate inbound capture -> exactly 1 row" "1" \
    "$(db_scalar "$DB_D" "SELECT COUNT(*) FROM conversation_log WHERE direction='in'")"

# ---------------------------------------------------------------------------
# (f) MULTI-AGENT SCOPE -- a session only ever replays its OWN chat
# ---------------------------------------------------------------------------
echo ""
echo "(f) Multi-agent scope"

DB_M="$TMPDIR_BASE/m.db"
emit_inbound 100 1 "FO_AGENS_UZENET" "$INSTALL_DIR"             | run_hook ledger-capture.py "$DB_M"
emit_inbound 200 1 "DIA_UZENET"      "$INSTALL_DIR/agents/dia"  | run_hook ledger-capture.py "$DB_M"
emit_session "$INSTALL_DIR/agents/dia" | run_hook ledger-replay.py "$DB_M" > "$TMPDIR_BASE/m.json"
M_CTX="$(ctx_of "$TMPDIR_BASE/m.json")"
if printf '%s' "$M_CTX" | grep -q "DIA_UZENET"; then
    pass "scope: dia session replays its own chat"
else
    fail "scope: dia session did not replay its own chat"
fi
if printf '%s' "$M_CTX" | grep -q "FO_AGENS_UZENET"; then
    fail "scope: dia session LEAKED the main agent's chat"
else
    pass "scope: dia session does not see the main agent's chat"
fi

# ---------------------------------------------------------------------------
# EDGE CASES
# ---------------------------------------------------------------------------
echo ""
echo "Edge cases"

# Edge 1: prompt with no channel block -> 0 rows, exit 0
DB_E1="$TMPDIR_BASE/e1.db"
echo '{"hook_event_name":"UserPromptSubmit","prompt":"Hello, how are you today?"}' | run_hook ledger-capture.py "$DB_E1"
E1_COUNT="$(db_scalar "$DB_E1" "SELECT COUNT(*) FROM conversation_log")"
if [ "$E1_COUNT" = "0" ] || [ "$E1_COUNT" = "NULL" ]; then
    pass "edge: no-channel prompt inserts 0 rows"
else
    fail "edge: no-channel prompt inserted unexpected rows: $E1_COUNT"
fi

# Edge 2: malformed / empty stdin -> no crash, exit 0
DB_E2="$TMPDIR_BASE/e2.db"
printf '' | run_hook ledger-capture.py "$DB_E2" \
    && pass "edge: empty stdin does not crash ledger-capture" \
    || fail "edge: empty stdin crashed ledger-capture"
printf 'not json at all {{{' | run_hook ledger-capture.py "$DB_E2" \
    && pass "edge: malformed JSON does not crash ledger-capture" \
    || fail "edge: malformed JSON crashed ledger-capture"
printf '' | run_hook ledger-outbound.py "$DB_E2" \
    && pass "edge: empty stdin does not crash ledger-outbound" \
    || fail "edge: empty stdin crashed ledger-outbound"
printf 'not json' | run_hook ledger-outbound.py "$DB_E2" \
    && pass "edge: malformed JSON does not crash ledger-outbound" \
    || fail "edge: malformed JSON crashed ledger-outbound"

# Edge 3: outbound hook with a non-telegram tool -> no out row recorded
DB_E3="$TMPDIR_BASE/e3.db"
echo '{"tool_name":"mcp__github__create_issue","tool_input":{"chat_id":"8517922966","text":"irrelevant"}}' \
    | run_hook ledger-outbound.py "$DB_E3"
E3_OUT="$(db_scalar "$DB_E3" "SELECT COUNT(*) FROM conversation_log WHERE direction='out'")"
if [ "$E3_OUT" = "0" ] || [ "$E3_OUT" = "NULL" ]; then
    pass "edge: non-telegram tool records no outbound row"
else
    fail "edge: non-telegram tool recorded an outbound row: $E3_OUT"
fi

# ---------------------------------------------------------------------------
# (g) LIVE-SESSION DRAIN -- re-surface an open question into a running session
# ---------------------------------------------------------------------------
echo ""
echo "(g) Live-session open-question drain"

# (g1) aged + unanswered + not yet surfaced -> writes block + updates statefile
mkdir -p "$TMPDIR_BASE/ld1"; DB_LD1="$TMPDIR_BASE/ld1/x.db"
emit_inbound 8517922966 1122 "Elveszett elo kerdes" | run_hook ledger-capture.py "$DB_LD1"
age_rows "$DB_LD1" 120
OUT_G1="$(run_drain "$DB_LD1")"
if printf '%s' "$OUT_G1" | grep -q "OPEN_QUESTION chat_id=8517922966 message_id=1122"; then
    pass "live drain: surfaces an aged, unanswered open question"
else
    fail "live drain: did not surface the open question (got: $OUT_G1)"
fi
if printf '%s' "$OUT_G1" | grep -q "Elveszett elo kerdes"; then
    pass "live drain: output includes the question text"
else
    fail "live drain: output missing question text"
fi
assert_eq "live drain: statefile records the surfaced message_id" "1122" \
    "$(cat "$TMPDIR_BASE/ld1/.ledger-drain-marveen" 2>/dev/null)"

# (g2) same open question again -> dedup, no output
OUT_G2="$(run_drain "$DB_LD1")"
assert_eq "live drain: dedup suppresses re-surfacing the same message_id" "" "$OUT_G2"

# (g3) a later 'out' answered it -> no output
mkdir -p "$TMPDIR_BASE/ld3"; DB_LD3="$TMPDIR_BASE/ld3/x.db"
emit_inbound 8517922966 1130 "Megvalaszolt kerdes" | run_hook ledger-capture.py "$DB_LD3"
age_rows "$DB_LD3" 120
emit_reply 8517922966 "Itt a valasz" | run_hook ledger-outbound.py "$DB_LD3"
OUT_G3="$(run_drain "$DB_LD3")"
assert_eq "live drain: an answered question is not surfaced" "" "$OUT_G3"

# (g4) open question younger than the grace window (in-flight) -> no output
mkdir -p "$TMPDIR_BASE/ld4"; DB_LD4="$TMPDIR_BASE/ld4/x.db"
emit_inbound 8517922966 1131 "Epp most erkezett" | run_hook ledger-capture.py "$DB_LD4"
OUT_G4="$(run_drain "$DB_LD4")"
assert_eq "live drain: in-flight question (within grace) is not surfaced" "" "$OUT_G4"

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
