#!/bin/bash
# Contract tests for scripts/hooks/taskstate-stub.py
# Run: bash scripts/__tests__/taskstate-stub.test.sh
#
# Covers the four checks bigme requires:
#  1. Live record (consumed=false, pendingDecision set) -> hook does NOT overwrite
#  2. No record / consumed=true -> hook writes stub; replay returns it
#  3. Broken input -> hook exits 0 (never blocks the prompt)
#  4. cwd derivation: install-root -> MAIN_AGENT_ID; agents/<name> -> <name>

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$INSTALL_DIR/scripts/hooks/taskstate-stub.py"
TOKEN="$(cat "$INSTALL_DIR/store/.dashboard-token" 2>/dev/null || echo "")"
API="http://localhost:3420"

# Isolated temp state dir -- never touches real records
FAKE_STATE_DIR="$(mktemp -d)"
cleanup() { rm -rf "$FAKE_STATE_DIR"; }
trap cleanup EXIT

# Helper: run the real hook with TASKSTATE_DIR_OVERRIDE + MAIN_AGENT_ID.
# Uses python3 to build the JSON payload so any prompt content (newlines,
# quotes, etc.) is safely escaped.
run_hook() {
    local agent_id="$1" cwd="$2" prompt="$3"
    python3 -c "import json,sys; sys.stdout.write(json.dumps({'cwd':sys.argv[1],'prompt':sys.argv[2]}))" \
        "$cwd" "$prompt" \
        | MAIN_AGENT_ID="$agent_id" \
          TASKSTATE_DIR_OVERRIDE="$FAKE_STATE_DIR" \
          python3 "$HOOK" 2>/dev/null
}

# Helper: write a record directly into FAKE_STATE_DIR
write_record() {
    local agent="$1" consumed="$2" pending="$3"
    cat > "$FAKE_STATE_DIR/${agent}.json" << RECEOF
{
  "agent": "$agent",
  "doneSteps": ["step-A"],
  "alreadyDelegated": [],
  "nextAction": "continue the work",
  "pendingDecision": "$pending",
  "summary": "Rich heartbeat record",
  "ts": $(date +%s)000,
  "consumed": $consumed
}
RECEOF
}

# Helper: read one JSON field from a record
read_field() {
    python3 -c "import json; d=json.load(open('$FAKE_STATE_DIR/${1}.json')); print(d.get('$2',''))" 2>/dev/null
}

echo "taskstate-stub tests"
echo "===================="

# ---------------------------------------------------------------------------
# (1) Live record (consumed=false, pendingDecision set) -> hook must NOT overwrite
# ---------------------------------------------------------------------------
echo ""
echo "(1) Live record guard: consumed=false -> hook does NOT overwrite"
write_record "bigme" "false" "Janos dontesere var a fizetesrol"
BEFORE_PENDING="$(read_field bigme pendingDecision)"
run_hook "bigme" "$INSTALL_DIR" "Uj keres erkezik"
EXIT_CODE=$?
AFTER_PENDING="$(read_field bigme pendingDecision)"
assert_eq "1a: hook exits 0 with live record" "0" "$EXIT_CODE"
assert_eq "1b: pendingDecision unchanged" "$BEFORE_PENDING" "$AFTER_PENDING"
AFTER_STUB="$(read_field bigme stub)"
assert_eq "1c: stub field absent (not an overwrite)" "" "$AFTER_STUB"

# ---------------------------------------------------------------------------
# (2a) No record -> hook writes stub
# ---------------------------------------------------------------------------
echo ""
echo "(2a) No record -> hook writes stub"
rm -f "$FAKE_STATE_DIR/testagent.json"
run_hook "testagent" "$INSTALL_DIR" "Teszt prompt elso sora
Masodik sor"
[ -f "$FAKE_STATE_DIR/testagent.json" ] && pass "2a-i: stub file created" || fail "2a-i: stub file NOT created"
STUB_SUMMARY="$(read_field testagent summary)"
assert_eq "2a-ii: summary = first line of prompt" "Teszt prompt elso sora" "$STUB_SUMMARY"
STUB_FLAG="$(read_field testagent stub)"
assert_eq "2a-iii: stub=true marker present" "True" "$STUB_FLAG"
STUB_CONSUMED="$(read_field testagent consumed)"
assert_eq "2a-iv: consumed=false" "False" "$STUB_CONSUMED"

# Replay via real API (copy stub into real store temporarily)
if [ -n "$TOKEN" ]; then
    REAL_STATE_DIR="$INSTALL_DIR/store/agent-taskstate"
    BACKUP="$REAL_STATE_DIR/testagent.json.bak-test-$$"
    [ -f "$REAL_STATE_DIR/testagent.json" ] && cp "$REAL_STATE_DIR/testagent.json" "$BACKUP" || true
    cp "$FAKE_STATE_DIR/testagent.json" "$REAL_STATE_DIR/testagent.json"
    REPLAY_RESP="$(curl -s -H "Authorization: Bearer $TOKEN" \
        "$API/api/agent-taskstate/testagent/replay?source=startup" 2>/dev/null)"
    REPLAY_CTX="$(printf '%s' "$REPLAY_RESP" \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('additionalContext') or '')" 2>/dev/null)"
    rm -f "$REAL_STATE_DIR/testagent.json"
    [ -f "$BACKUP" ] && mv "$BACKUP" "$REAL_STATE_DIR/testagent.json" || true

    if printf '%s' "$REPLAY_CTX" | grep -q "TASK-FOLYTATAS"; then
        pass "2a-v: GET replay?source=startup returns injection block"
    else
        fail "2a-v: GET replay?source=startup missing injection block (got: ${REPLAY_CTX:0:80})"
    fi
else
    echo "  SKIP: 2a-v (no dashboard token)"
fi

# ---------------------------------------------------------------------------
# (2b) consumed=true record -> hook replaces with stub
# ---------------------------------------------------------------------------
echo ""
echo "(2b) consumed=true record -> hook writes new stub"
write_record "consumedagent" "true" ""
run_hook "consumedagent" "$INSTALL_DIR" "Valami uj keres"
NEW_STUB="$(read_field consumedagent stub)"
assert_eq "2b-i: consumed record replaced with stub" "True" "$NEW_STUB"
NEW_CONSUMED="$(read_field consumedagent consumed)"
assert_eq "2b-ii: new stub consumed=false" "False" "$NEW_CONSUMED"

# ---------------------------------------------------------------------------
# (3) Broken / empty input -> hook exits 0 (never blocks the prompt)
# ---------------------------------------------------------------------------
echo ""
echo "(3) Fail-open: broken input -> exit 0"
echo ""         | TASKSTATE_DIR_OVERRIDE="$FAKE_STATE_DIR" python3 "$HOOK" 2>/dev/null
assert_eq "3a: empty stdin -> exit 0" "0" "$?"
echo "not-json" | TASKSTATE_DIR_OVERRIDE="$FAKE_STATE_DIR" python3 "$HOOK" 2>/dev/null
assert_eq "3b: invalid JSON -> exit 0" "0" "$?"
echo '{"no_prompt":true}' | TASKSTATE_DIR_OVERRIDE="$FAKE_STATE_DIR" python3 "$HOOK" 2>/dev/null
assert_eq "3c: missing prompt field -> exit 0" "0" "$?"
echo '{"cwd":null,"prompt":null}' | TASKSTATE_DIR_OVERRIDE="$FAKE_STATE_DIR" python3 "$HOOK" 2>/dev/null
assert_eq "3d: null cwd+prompt -> exit 0" "0" "$?"

# ---------------------------------------------------------------------------
# (5) Real-world prompt shapes: wrapper extraction
#     bigme tested these three inputs; all were wrong before the fix.
# ---------------------------------------------------------------------------
echo ""
echo "(5) Real prompt shapes: wrapper extraction"

# Helper: run hook with a given prompt, return the written summary field
hook_summary() {
    local agent="$1" prompt="$2"
    rm -f "$FAKE_STATE_DIR/${agent}.json"
    run_hook "$agent" "$INSTALL_DIR" "$prompt" >/dev/null 2>&1
    read_field "$agent" summary
}

# 5a: Scheduled task -- notice header wraps real content inside <scheduled-task>
SCHED_PROMPT='SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ... </scheduled-task> block is one of YOUR OWN scheduled tasks.
[Heartbeat: slarti-rendszer-ellenorzes]
<scheduled-task source="scheduled-task:slarti-rendszer-ellenorzes">
RENDSZER-ELLENORZES. Ez a te allando felelosseged.
## 1. MERES
...
</scheduled-task>'
GOT_5A="$(hook_summary "agent5a" "$SCHED_PROMPT")"
assert_eq "5a: scheduled-task wrapper -> first line of task content" \
    "RENDSZER-ELLENORZES. Ez a te allando felelosseged." "$GOT_5A"

# 5b: Telegram channel message -- first line of prompt is the opening tag
CHAN_PROMPT='<channel source="plugin:telegram:telegram" chat_id="5233594868" message_id="3598" user="mogganhun">
Nezd meg miert nem jott a napindito
</channel>'
GOT_5B="$(hook_summary "agent5b" "$CHAN_PROMPT")"
assert_eq "5b: channel wrapper -> inner message text" \
    "Nezd meg miert nem jott a napindito" "$GOT_5B"

# 5c: Plain typed prompt (control) -- must still work
PLAIN_PROMPT="Nezd meg miert nem jott a napindito"
GOT_5C="$(hook_summary "agent5c" "$PLAIN_PROMPT")"
assert_eq "5c: plain prompt -> first line unchanged" \
    "Nezd meg miert nem jott a napindito" "$GOT_5C"

# 5d: Notice placeholder <scheduled-task source="..."> must NOT match
# (the inline "..." source is the truncated example in the notice prefix).
# Verify the summary starts with the notice text, NOT with inner task content.
NOTICE_ONLY='SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ... </scheduled-task> block.'
GOT_5D="$(hook_summary "agent5d" "$NOTICE_ONLY")"
case "$GOT_5D" in
  "SCHEDULED TASK NOTICE"*) pass "5d: notice-only placeholder -> falls back to raw first line (not inner '...')" ;;
  *) fail "5d: notice-only placeholder -> expected raw first line, got: '${GOT_5D:0:60}'" ;;
esac

# ---------------------------------------------------------------------------
# (4) cwd derivation
# ---------------------------------------------------------------------------
echo ""
echo "(4) cwd -> agent_id derivation"

AGENT_MAIN="$(MAIN_AGENT_ID="bigme" python3 -c "
import sys; sys.path.insert(0,'$INSTALL_DIR/scripts/hooks')
import ledger_lib, os; os.environ['MAIN_AGENT_ID']='bigme'
print(ledger_lib.agent_id_from_cwd('$INSTALL_DIR'))
")"
assert_eq "4a: install-root cwd -> MAIN_AGENT_ID (bigme)" "bigme" "$AGENT_MAIN"

AGENT_SUB="$(python3 -c "
import sys; sys.path.insert(0,'$INSTALL_DIR/scripts/hooks')
import ledger_lib
print(ledger_lib.agent_id_from_cwd('$INSTALL_DIR/agents/slarti'))
")"
assert_eq "4b: agents/slarti cwd -> 'slarti'" "slarti" "$AGENT_SUB"

# ---------------------------------------------------------------------------
echo ""
echo "===================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
