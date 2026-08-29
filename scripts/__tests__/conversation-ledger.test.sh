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
    # OWNER_NAME is pinned to 'Gyula' so the replay's inbound prefix is
    # deterministic regardless of the install's .env (assertions below grep for
    # "Gyula:"). Same reasoning as pinning MAIN_AGENT_ID.
    LEDGER_DB_PATH="$db" LEDGER_OWNER_CHAT="10000000001" MAIN_AGENT_ID="marveen" \
        OWNER_NAME="Gyula" \
        python3 "$HOOKS_DIR/$hook" "$@"
}

# Run the live-drain from cwd=INSTALL_DIR so agent_id resolves to 'marveen'
# (matching the capture/outbound rows). The drain's dedup statefile lands beside
# the DB (dirname of LEDGER_DB_PATH), so per-case subdirs keep it isolated.
run_drain() { # db
    ( cd "$INSTALL_DIR" && LEDGER_DB_PATH="$1" LEDGER_OWNER_CHAT="10000000001" \
        MAIN_AGENT_ID="marveen" python3 "$HOOKS_DIR/ledger-live-drain.py" )
}

# Age every row in a ledger DB backwards so an open question clears the grace window.
age_rows() { # db seconds
    python3 - "$1" "$2" <<'PYEOF'
import sqlite3, sys
# Tolerant of a missing table: when a hook under test recorded nothing, the
# caller must still reach its assertion and FAIL cleanly. Aborting here would
# hide every later check in the run.
con = sqlite3.connect(sys.argv[1])
try:
    con.execute("UPDATE conversation_log SET created_at = created_at - ?", (int(sys.argv[2]),))
    con.commit()
except Exception:
    pass
finally:
    con.close()
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

# Emit an inbound payload from ANY channel provider (the envelope shape is the
# same for every plugin; only the source attribute differs).
emit_inbound_provider() { # provider chat_id message_id text [cwd]
    python3 - "$@" <<'PYEOF'
import json, sys
provider, chat_id, message_id, text = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
block = (f'<channel source="plugin:{provider}:{provider}" chat_id="{chat_id}" '
         f'message_id="{message_id}" user="x" ts="2026-06-02T14:20:25.000Z">\n{text}\n</channel>')
payload = {"hook_event_name": "UserPromptSubmit", "prompt": block}
if len(sys.argv) > 5:
    payload["cwd"] = sys.argv[5]
print(json.dumps(payload))
PYEOF
}

# Emit a reply PostToolUse payload for ANY channel provider. `response` is the
# tool's plain-text answer, from which the message_id is parsed.
emit_reply_provider() { # provider chat_id text response
    python3 - "$@" <<'PYEOF'
import json, sys
provider, chat_id, text, response = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
payload = {"tool_name": f"mcp__plugin_{provider}_{provider}__reply",
           "tool_input": {"chat_id": chat_id, "text": text},
           "tool_response": [{"type": "text", "text": response}]}
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
emit_inbound 10000000001 1054 "Jok a Fokusz e-mail cimek" | run_hook ledger-capture.py "$DB_A"

assert_eq "inbound capture: exactly 1 row" "1" \
    "$(db_scalar "$DB_A" "SELECT COUNT(*) FROM conversation_log")"
assert_eq "inbound capture: direction='in'" "in" \
    "$(db_scalar "$DB_A" "SELECT direction FROM conversation_log")"
assert_eq "inbound capture: chat_id" "10000000001" \
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
emit_inbound 10000000001 1054 "kerdes" | run_hook ledger-capture.py "$DB_B"
emit_reply 10000000001 "ez a valaszom" | run_hook ledger-outbound.py "$DB_B"

assert_eq "outbound: exactly 1 out row" "1" \
    "$(db_scalar "$DB_B" "SELECT COUNT(*) FROM conversation_log WHERE direction='out'")"
assert_eq "outbound: reply text recorded" "ez a valaszom" \
    "$(db_scalar "$DB_B" "SELECT text FROM conversation_log WHERE direction='out'")"
assert_eq "outbound: out row chat_id" "10000000001" \
    "$(db_scalar "$DB_B" "SELECT chat_id FROM conversation_log WHERE direction='out'")"

# chat_id=0 shorthand resolves to the owner chat
DB_B2="$TMPDIR_BASE/b2.db"
emit_reply 0 "valasz nullaval" | run_hook ledger-outbound.py "$DB_B2"
assert_eq "outbound: chat_id=0 shorthand resolves to owner chat" "10000000001" \
    "$(db_scalar "$DB_B2" "SELECT chat_id FROM conversation_log WHERE direction='out'")"

# ---------------------------------------------------------------------------
# (c) STARTUP REPLAY -- context window + open question
# ---------------------------------------------------------------------------
echo ""
echo "(c) Startup replay"

# Open question present: single unanswered inbound
DB_C="$TMPDIR_BASE/c.db"
emit_inbound 10000000001 1054 "Jok a Fokusz cimek" | run_hook ledger-capture.py "$DB_C"
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
emit_inbound 10000000001 1 "ELSO_UZENET"  | run_hook ledger-capture.py  "$DB_CW"
emit_reply   10000000001   "VALASZ_KOZEP" | run_hook ledger-outbound.py "$DB_CW"
emit_inbound 10000000001 2 "MASODIK_UZENET" | run_hook ledger-capture.py "$DB_CW"
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
emit_inbound 10000000001 1054 "regi kerdes" | run_hook ledger-capture.py "$DB_C_DONE"
emit_reply 10000000001 "regi valasz" | run_hook ledger-outbound.py "$DB_C_DONE"
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
    emit_inbound 10000000001 "$i" "MSG_NUM_${i}" | run_hook ledger-capture.py "$DB_N"
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
# (d2) BYTE-BUDGET SELF-TRIM -- the FINAL payload stays under the harness cap,
#      dropping oldest turns while the freshest END survives uncut.
#      Regression guard for the ~11KB harness preview-truncation bug: the hook
#      must self-measure real UTF-8 bytes (accents included) and keep the whole
#      json.dumps(...) blob under LEDGER_CONTEXT_BYTE_BUDGET.
# ---------------------------------------------------------------------------
echo ""
echo "(d2) Byte-budget self-trim"

# Byte size of a replay hook's raw stdout (the exact blob the harness measures).
payload_bytes() { LC_ALL=C wc -c < "$1" | tr -d ' '; }

DB_BB="$TMPDIR_BASE/bb.db"
# 40 chatty turns with accented (2-byte UTF-8) content -> well over any KB cap.
for i in $(seq 1 40); do
    emit_inbound 10000000001 "$i" "UZENET_${i} árvíztűrő tükörfúrógép őőőűűű ééé ááá visszavisszhang" \
        | run_hook ledger-capture.py "$DB_BB"
done
# The very last turn carries a unique marker we must NOT lose to preview-truncation.
emit_inbound 10000000001 999 "LEGFRISSEBB_VEG_MARKER a friss veg amit latni kell" \
    | run_hook ledger-capture.py "$DB_BB"

# Force a tight budget (4096 B) AND a wide window (no N-limit interference) so the
# byte loop is what actually trims. LEGFRISSEBB marker must survive; oldest drops.
LEDGER_CONTEXT_BYTE_BUDGET=4096 LEDGER_CONTEXT_WINDOW=100 \
    run_hook ledger-replay.py "$DB_BB" < <(emit_session) > "$TMPDIR_BASE/bb.json"

BB_BYTES="$(payload_bytes "$TMPDIR_BASE/bb.json")"
if [ "$BB_BYTES" -le 4096 ]; then
    pass "byte-budget: final payload ($BB_BYTES B) stays under the 4096 B budget"
else
    fail "byte-budget: payload $BB_BYTES B exceeds the 4096 B budget"
fi

BB_CTX="$(ctx_of "$TMPDIR_BASE/bb.json")"
if printf '%s' "$BB_CTX" | grep -q "LEGFRISSEBB_VEG_MARKER"; then
    pass "byte-budget: freshest END survives the trim"
else
    fail "byte-budget: freshest END was dropped (preview-truncation regression)"
fi
if printf '%s' "$BB_CTX" | grep -q "UZENET_1 "; then
    fail "byte-budget: oldest turn should have been trimmed but is present"
else
    pass "byte-budget: oldest turns dropped first (freshest-end reorder preserved)"
fi
# Closing directive (KÖTELEZŐ) must always survive -- it is rebuilt into every payload.
if printf '%s' "$BB_CTX" | grep -q "KÖTELEZŐ:"; then
    pass "byte-budget: mandatory directive present in the trimmed payload"
else
    fail "byte-budget: mandatory directive lost during trim"
fi

# Single oversized freshest turn: snippet cap keeps even a lone huge turn under
# budget (no drop-to-empty). Build a >8KB single message.
DB_BB2="$TMPDIR_BASE/bb2.db"
HUGE="$(python3 -c 'print("Q" + "óőűá"*3000 + "_VEGE")')"
emit_inbound 10000000001 1 "$HUGE" | run_hook ledger-capture.py "$DB_BB2"
LEDGER_CONTEXT_BYTE_BUDGET=8192 run_hook ledger-replay.py "$DB_BB2" < <(emit_session) > "$TMPDIR_BASE/bb2.json"
BB2_BYTES="$(payload_bytes "$TMPDIR_BASE/bb2.json")"
if [ "$BB2_BYTES" -le 8192 ] && [ "$BB2_BYTES" -gt 0 ]; then
    pass "byte-budget: a lone oversized turn is snippet-capped under budget ($BB2_BYTES B)"
else
    fail "byte-budget: lone oversized turn not bounded ($BB2_BYTES B)"
fi

# ---------------------------------------------------------------------------
# (e) IDEMPOTENCY -- duplicate inbound capture yields one row
# ---------------------------------------------------------------------------
echo ""
echo "(e) Idempotency"

DB_D="$TMPDIR_BASE/d.db"
emit_inbound 10000000001 1054 "ugyanaz" | run_hook ledger-capture.py "$DB_D"
emit_inbound 10000000001 1054 "ugyanaz" | run_hook ledger-capture.py "$DB_D"
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
echo '{"tool_name":"mcp__github__create_issue","tool_input":{"chat_id":"10000000001","text":"irrelevant"}}' \
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
emit_inbound 10000000001 1122 "Elveszett elo kerdes" | run_hook ledger-capture.py "$DB_LD1"
age_rows "$DB_LD1" 120
OUT_G1="$(run_drain "$DB_LD1")"
if printf '%s' "$OUT_G1" | grep -q "OPEN_QUESTION chat_id=10000000001 message_id=1122"; then
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
emit_inbound 10000000001 1130 "Megvalaszolt kerdes" | run_hook ledger-capture.py "$DB_LD3"
age_rows "$DB_LD3" 120
emit_reply 10000000001 "Itt a valasz" | run_hook ledger-outbound.py "$DB_LD3"
OUT_G3="$(run_drain "$DB_LD3")"
assert_eq "live drain: an answered question is not surfaced" "" "$OUT_G3"

# (g4) open question younger than the grace window (in-flight) -> no output
mkdir -p "$TMPDIR_BASE/ld4"; DB_LD4="$TMPDIR_BASE/ld4/x.db"
emit_inbound 10000000001 1131 "Epp most erkezett" | run_hook ledger-capture.py "$DB_LD4"
OUT_G4="$(run_drain "$DB_LD4")"
assert_eq "live drain: in-flight question (within grace) is not surfaced" "" "$OUT_G4"

# ---------------------------------------------------------------------------
# (h) SECOND CHANNEL PROVIDER -- the ledger must not be blind to a non-Telegram
#     channel. Regression guard: both hooks were hardcoded to
#     `plugin:telegram:telegram` / a "telegram" substring, so an install whose
#     primary channel was Discord recorded ZERO turns -- and the failure was
#     invisible, because the replay still produced a non-empty block from the
#     one provider that WAS captured.
# ---------------------------------------------------------------------------
echo ""
echo "(h) Second channel provider (discord)"

# (h1) inbound from a non-telegram provider is captured
DB_H="$TMPDIR_BASE/h.db"
emit_inbound_provider discord 20000000002 7001 "kerdes egy masik csatornarol" \
    | run_hook ledger-capture.py "$DB_H"
H_IN="$(db_scalar "$DB_H" "SELECT text FROM conversation_log WHERE direction='in'")"
assert_eq "discord inbound is captured" "kerdes egy masik csatornarol" "$H_IN"
H_CHAT="$(db_scalar "$DB_H" "SELECT chat_id FROM conversation_log WHERE direction='in'")"
assert_eq "discord inbound keeps its chat_id" "20000000002" "$H_CHAT"

# (h2) outbound reply from a non-telegram provider is captured
emit_reply_provider discord 20000000002 "valasz egy masik csatornara" "sent (id: 7002)" \
    | run_hook ledger-outbound.py "$DB_H"
H_OUT="$(db_scalar "$DB_H" "SELECT text FROM conversation_log WHERE direction='out'")"
assert_eq "discord outbound is captured" "valasz egy masik csatornara" "$H_OUT"
H_MID="$(db_scalar "$DB_H" "SELECT message_id FROM conversation_log WHERE direction='out'")"
assert_eq "discord outbound records its message_id" "7002" "$H_MID"

# (h3) a split reply answers "sent 2 parts (ids: A, B)" -> the first id is used
DB_H2="$TMPDIR_BASE/h2.db"
emit_reply_provider discord 10000000001 "hosszu valasz" "sent 2 parts (ids: 991, 992)" \
    | run_hook ledger-outbound.py "$DB_H2"
H2_MID="$(db_scalar "$DB_H2" "SELECT message_id FROM conversation_log WHERE direction='out'")"
assert_eq "multi-part reply extracts the first message_id" "991" "$H2_MID"

# (h4) the open question closes across providers: an unanswered discord inbound
#      IS surfaced by the drain, and stops being surfaced once answered.
mkdir -p "$TMPDIR_BASE/h3"; DB_H3="$TMPDIR_BASE/h3/x.db"
emit_inbound_provider discord 10000000001 4201 "kerdes discordon" | run_hook ledger-capture.py "$DB_H3"
age_rows "$DB_H3" 600
OUT_H3A="$(run_drain "$DB_H3")"
case "$OUT_H3A" in
    *"kerdes discordon"*) pass "discord open question is surfaced by the drain" ;;
    *) fail "discord open question was NOT surfaced by the drain" ;;
esac
emit_reply_provider discord 10000000001 "valasz" "sent (id: 4202)" | run_hook ledger-outbound.py "$DB_H3"
mkdir -p "$TMPDIR_BASE/h3b"; cp "$DB_H3" "$TMPDIR_BASE/h3b/x.db"
OUT_H3B="$(run_drain "$TMPDIR_BASE/h3b/x.db")"
assert_eq "an answered discord question is not surfaced" "" "$OUT_H3B"

# (h5) both providers land in ONE transcript
DB_H4="$TMPDIR_BASE/h4.db"
emit_inbound 10000000001 5001 "TELEGRAM_UZENET" | run_hook ledger-capture.py "$DB_H4"
emit_inbound_provider discord 20000000002 5002 "DISCORD_UZENET" \
    | run_hook ledger-capture.py "$DB_H4"
emit_session | run_hook ledger-replay.py "$DB_H4" > "$TMPDIR_BASE/h4.json"
H4_CTX="$(ctx_of "$TMPDIR_BASE/h4.json")"
case "$H4_CTX" in
    *TELEGRAM_UZENET*) pass "replay keeps the telegram turn" ;;
    *) fail "replay lost the telegram turn" ;;
esac
case "$H4_CTX" in
    *DISCORD_UZENET*) pass "replay includes the discord turn" ;;
    *) fail "replay lost the discord turn -- the ledger is provider-blind" ;;
esac

# (h6) NEGATIVE: a non-channel tool that merely contains "reply" is still
#      rejected. The gate is anchored on the mcp__plugin_<x>__reply shape, so
#      widening it to a second provider must not widen it to everything.
DB_H5="$TMPDIR_BASE/h5.db"
echo '{"tool_name":"mcp__github__reply_to_review_comment","tool_input":{"chat_id":"10000000001","text":"nope"}}' \
    | run_hook ledger-outbound.py "$DB_H5"
H5_OUT="$(db_scalar "$DB_H5" "SELECT COUNT(*) FROM conversation_log WHERE direction='out'")"
if [ "$H5_OUT" = "0" ] || [ "$H5_OUT" = "NULL" ]; then
    pass "a non-channel tool containing 'reply' records no outbound row"
else
    fail "a non-channel 'reply' tool recorded an outbound row: $H5_OUT"
fi

# (h7) NEGATIVE: a channel plugin's NON-reply tool (react/edit) records nothing.
DB_H6="$TMPDIR_BASE/h6.db"
echo '{"tool_name":"mcp__plugin_discord_discord__react","tool_input":{"chat_id":"10000000001","text":"x"}}' \
    | run_hook ledger-outbound.py "$DB_H6"
H6_OUT="$(db_scalar "$DB_H6" "SELECT COUNT(*) FROM conversation_log WHERE direction='out'")"
if [ "$H6_OUT" = "0" ] || [ "$H6_OUT" = "NULL" ]; then
    pass "a channel plugin's non-reply tool records no outbound row"
else
    fail "a non-reply channel tool recorded an outbound row: $H6_OUT"
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
