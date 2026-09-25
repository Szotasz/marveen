#!/bin/bash
# Contract tests for the userbot-prober ARMING PRECONDITION gate (HBTAILVAK914).
# Run: bash scripts/__tests__/userbot-arming-gate.test.sh
#
# The precondition ("fix the tail-blind transcript reader BEFORE arming the
# deafness prober") must live where the arming operator reads, not on a kanban
# card. Two surfaces carry it, and the login script ENFORCES it: `signin` (the
# step that persists the session file) demands an explicit confirmation.
#
# The login script imports telethon at module scope, so it cannot be executed
# here; the gate function is extracted via ast and run in isolation instead.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOGIN="$REPO/scripts/watchdog-userbot-login.py"
PROBER="$REPO/scripts/watchdog-inbound-prober.py"

echo "arming-precondition surfaces"

grep -q "HBTAILVAK914" "$LOGIN" \
  && pass "login script names the precondition card" \
  || fail "login script names the precondition card"

# The gate must sit on signin (the arming act), before the telethon call.
awk '/elif cmd == "signin":/,/do_signin/' "$LOGIN" | grep -q "confirm_arming_precondition()" \
  && pass "signin branch calls the gate before do_signin" \
  || fail "signin branch calls the gate before do_signin"

grep -q "HBTAILVAK914" "$PROBER" \
  && pass "prober manual-gate message names the precondition card" \
  || fail "prober manual-gate message names the precondition card"

echo
echo "gate mechanism (extracted via ast, telethon not needed)"

EXTRACTOR="$(mktemp)"
trap 'rm -f "$EXTRACTOR"' EXIT
cat > "$EXTRACTOR" <<'PYEOF'
import ast, sys, os
src = open(sys.argv[1]).read()
tree = ast.parse(src)
wanted = {}
for node in tree.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "TAIL_BLIND_WARNING":
        wanted["warn"] = ast.get_source_segment(src, node)
    if isinstance(node, ast.FunctionDef) and node.name == "confirm_arming_precondition":
        wanted["fn"] = ast.get_source_segment(src, node)
if len(wanted) != 2:
    print("EXTRACT_FAILED"); sys.exit(3)
ns = {"sys": sys, "os": os}
exec(wanted["warn"] + "\n" + wanted["fn"], ns)
try:
    ns["confirm_arming_precondition"]()
    print("GATE_PASSED")
except SystemExit as e:
    print(f"GATE_BLOCKED rc={e.code}")
PYEOF

run_gate() {
  # $1: HBTAILVAK914_ACK value ("" = unset), $2: stdin fed to input()
  local ack="$1" stdin_val="$2"
  if [ -n "$stdin_val" ]; then
    HBTAILVAK914_ACK="$ack" python3 "$EXTRACTOR" "$LOGIN" <<<"$stdin_val"
  else
    HBTAILVAK914_ACK="$ack" python3 "$EXTRACTOR" "$LOGIN" < /dev/null
  fi
}

OUT="$(run_gate 1 "" 2>/dev/null)"
[ "$OUT" = "GATE_PASSED" ] \
  && pass "env ack (HBTAILVAK914_ACK=1) passes the gate" \
  || fail "env ack passes the gate (got '$OUT')"

OUT="$(run_gate "" "ELESITEM" 2>/dev/null)"
[ "$OUT" = "GATE_PASSED" ] \
  && pass "typed ELESITEM confirmation passes the gate" \
  || fail "typed ELESITEM passes the gate (got '$OUT')"

OUT="$(run_gate "" "igen" 2>/dev/null)"
[ "$OUT" = "GATE_BLOCKED rc=2" ] \
  && pass "any other answer blocks with exit 2" \
  || fail "other answer blocks with exit 2 (got '$OUT')"

OUT="$(run_gate "" "" 2>/dev/null)"
[ "$OUT" = "GATE_BLOCKED rc=2" ] \
  && pass "EOF/empty stdin blocks with exit 2 (non-interactive run cannot arm silently)" \
  || fail "EOF blocks with exit 2 (got '$OUT')"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
