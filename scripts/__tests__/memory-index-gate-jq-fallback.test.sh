#!/usr/bin/env bash
# MEMIDXJQ924 -- the gate must read its own state file WITHOUT jq.
#
# WHAT WENT WRONG, measured 2026-09-24 on this host (no jq installed): every
# jq call in memory-index-gate.sh sat behind a bare `2>/dev/null`, so without
# jq each field resolved to EMPTY and nothing said so. The running maximum is
# the one that hurts: it is carried in the state file, so losing it resets the
# peak to the current size. Measured end to end -- a 30008 B index followed by
# a 58 B one left `max_seen` at 58. That is exactly the silent data loss this
# gate exists to catch, happening inside the gate.
#
# The other fields fail SAFE (a missing link count wakes the agent), which is
# why this suite asserts the maximum first: it is the one that fails QUIET.
#
# The two sibling suites (memory-index-gate-linkcheck, -max-seen) deliberately
# REQUIRE jq and stop with exit 1 without it. That is right for them: they
# measure the gate's contracts, not its portability. This one measures the
# fallback, so it must run on a host that has no jq -- and it forces that
# condition even where jq exists, so the fallback is never left unmeasured.
#
# Run:  bash scripts/__tests__/memory-index-gate-jq-fallback.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
GATE="${GATE_BIN:-$ROOT/scripts/memory-index-gate.sh}"
FAILS=0; N=0
ok() { N=$((N+1)); if [ "$2" = "0" ]; then echo "PASS  $1"; else echo "FAIL  $1${3:+  -- $3}"; FAILS=$((FAILS+1)); fi; }

# The instrument proves its own target first: a no-op assertion is satisfied by
# a missing script just as well as by correct behaviour.
[ -x "$GATE" ] || { echo "FATAL: the gate is missing or not executable: $GATE" >&2; exit 2; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/memidxjq.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
BIN="$SANDBOX/bin"; mkdir -p "$BIN"
# Everything the gate calls, and NOT jq. Linking the tools by name (instead of
# emptying PATH) keeps the run realistic: an empty PATH also removes `dirname`
# and the failure then comes from the harness, not from the thing under test.
for t in awk cat date dirname printf python3 sort tr wc sed grep stat mktemp rm; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$BIN/$t"
done
run_nojq() { env PATH="$BIN" MEMORY_INDEX_PATH="$1" MEMORY_INDEX_STATE="$SANDBOX/state.json" \
                 /bin/bash "$GATE" >/dev/null 2>&1; }
state() { python3 -c "
import json,sys
try: d=json.load(open('$SANDBOX/state.json'))
except Exception: sys.exit(1)
v=d.get('$1')
print('' if v is None else v)
" 2>/dev/null; }

# POSITIVE CONTROL on the sandbox itself: if jq were reachable from it, every
# assertion below would measure the jq path and pass for the wrong reason.
#
# THE FORM MATTERS, AND THE FIRST ONE WAS BLIND (2026-09-24 review). It read
# `env PATH="$BIN" command -v jq`, which can NEVER find anything: `command` is
# a shell builtin and `env` cannot execute a builtin, so the check reported
# "no jq" even with jq sitting in the sandbox. A control that always says what
# you hoped is not a control. `/bin/sh -c` runs a real shell, so the builtin
# exists and the lookup is genuine.
sees_jq() { PATH="$1" /bin/sh -c 'command -v jq' >/dev/null 2>&1; }

# META-CONTROL: prove the check can SEE a jq before trusting it to say there is
# none. Same method the reviewer used to catch the blind form -- put one there
# and look. Without this, switching the form would be a claim, not a measurement.
FAKEBIN="$SANDBOX/fakebin"; mkdir -p "$FAKEBIN"
printf '#!/bin/sh\nexit 0\n' > "$FAKEBIN/jq"; chmod +x "$FAKEBIN/jq"
ok "the jq check is not blind: it SEES a jq that is there" \
   "$(sees_jq "$FAKEBIN" && echo 0 || echo 1)" \
   "the control cannot see a jq placed in front of it -- it proves nothing below"
ok "the sandbox PATH really has no jq" \
   "$(sees_jq "$BIN" && echo 1 || echo 0)" \
   "jq is visible from the sandbox; the fallback would not be exercised"

BIG="$SANDBOX/big.md"; SMALL="$SANDBOX/small.md"
python3 - "$BIG" "$SMALL" <<'PY'
import sys
lines = ["# Forro bejegyzesek"]
while sum(len(l) + 1 for l in lines) < 30000:
    lines.append("- [t](t-%04d.md) sor" % len(lines))
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
open(sys.argv[2], "w").write("# Forro bejegyzesek\n- rovid\n# Téma-hubok\n- [hub](hub.md)\n")
PY
: > "$SANDBOX/hub.md"

# POSITIVE CONTROL on the instrument: the state file must be written and
# readable at all, otherwise every field check below is vacuous.
rm -f "$SANDBOX/state.json"
run_nojq "$BIG"
BIG_MAX="$(state max_seen)"
ok "the gate writes a readable state file without jq" \
   "$([ -n "$BIG_MAX" ] && echo 0 || echo 1)" "no state file or no max_seen field"
ok "  ...and the first run records the real size as the peak" \
   "$([ "${BIG_MAX:-0}" -gt 24400 ] 2>/dev/null && echo 0 || echo 1)" "max_seen=$BIG_MAX"

BIG_AT="$(state max_seen_at)"; BIG_SINCE="$(state since)"

# One second between the runs, ON PURPOSE. Without it the timestamp assertion
# below passes for the wrong reason: when the state read resolves empty the gate
# takes the "no inherited peak" branch and stamps max_seen_at/since with NOW --
# which, inside the same second, equals the value it was supposed to have kept.
# Measured: with the runs back to back that assertion was GREEN on the broken
# gate. A second of wall clock is the cheapest way to make it mean something.
sleep 1

# THE ASSERTION THAT FAILS ON THE OLD CODE: the inherited peak survives a run
# on a small index. Without the fallback max_seen drops to the current size.
run_nojq "$SMALL"
SMALL_MAX="$(state max_seen)"
ok "the running maximum SURVIVES a later, smaller index" \
   "$([ "$SMALL_MAX" = "$BIG_MAX" ] && echo 0 || echo 1)" \
   "peak was $BIG_MAX, now $SMALL_MAX -- the state read resolved empty"
ok "the inherited timestamps survive too" \
   "$([ "$(state max_seen_at)" = "$BIG_AT" ] && [ "$(state since)" = "$BIG_SINCE" ] && echo 0 || echo 1)" \
   "max_seen_at $BIG_AT -> $(state max_seen_at), since $BIG_SINCE -> $(state since)"

# An array-valued field goes through the same reader; a scalar-only fallback
# would turn missing_list into a bare string and corrupt the state JSON.
ok "the state file stays valid JSON (the array field survives)" \
   "$(python3 -c "
import json
json.load(open('$SANDBOX/state.json'))
" 2>/dev/null && echo 0 || echo 1)" "the written state is not parseable"

# Parity, only where it can be measured. No SKIP: the fallback above is the
# point of this suite, and it ran.
# --- THE FAIL-SAFE ON A BROKEN LINK MEASUREMENT, WITHOUT jq -----------------
# Today's behaviour is right but unguarded (2026-09-24 review): a mutant whose
# python fallback returns "0" for every field makes the jq-less gate SKIP on a
# BROKEN link measurement -- it opens silently -- and all three suites stay
# green. An unmeasurable condition must WAKE: "we could not measure it" is not
# "it is fine". These checks turn red on that mutant.
lc() {   # lc <script-body> -> runs the gate with that link checker, echoes SKIP or WAKE
  printf '%s' "$1" > "$SANDBOX/lc.py"
  out="$(env PATH="$BIN" MEMORY_INDEX_PATH="$SMALL" MEMORY_INDEX_STATE="$SANDBOX/lstate.json" \
             MEMORY_LINKCHECK_BIN="$SANDBOX/lc.py" /bin/bash "$GATE" 2>/dev/null)"
  [ "$out" = "SKIP" ] && echo SKIP || echo WAKE
}

ok "broken (non-JSON) link-checker output without jq -> WAKE" \
   "$([ "$(lc 'import sys
sys.stdout.write("not json at all")')" = "WAKE" ] && echo 0 || echo 1)" \
   "the gate SKIPped on a link measurement it could not read"
ok "EMPTY link-checker output without jq -> WAKE" \
   "$([ "$(lc 'import sys')" = "WAKE" ] && echo 0 || echo 1)" \
   "the gate SKIPped on an empty link measurement"
ok "link checker exiting non-zero without jq -> WAKE" \
   "$([ "$(lc 'import sys
print("{}")
sys.exit(3)')" = "WAKE" ] && echo 0 || echo 1)" \
   "the gate SKIPped although the checker failed"

# AND THE OTHER DIRECTION, or the three above would also pass on a gate that
# wakes for everything: a VALID measurement must be read, and its number must
# decide. This is the check the reviewer marked optional; without it, reverting
# the link-branch read stays green.
lc_valid() {   # lc_valid <missing-count> -> SKIP or WAKE
  cat > "$SANDBOX/lc.py" <<EOF
import json
print(json.dumps({"missing": $1, "missing_occurrences": $1, "unique_targets": 3,
                  "links_checked": 10, "files_scanned": 2, "missing_list": []}))
EOF
  out="$(env PATH="$BIN" MEMORY_INDEX_PATH="$SMALL" MEMORY_INDEX_STATE="$SANDBOX/lstate.json" \
             MEMORY_LINKCHECK_BIN="$SANDBOX/lc.py" /bin/bash "$GATE" 2>/dev/null)"
  [ "$out" = "SKIP" ] && echo SKIP || echo WAKE
}
ok "a valid link measurement with missing=0 without jq -> SKIP" \
   "$([ "$(lc_valid 0)" = "SKIP" ] && echo 0 || echo 1)" "the gate woke on a clean link measurement"
ok "  ...and missing=2 -> WAKE (the count is really read)" \
   "$([ "$(lc_valid 2)" = "WAKE" ] && echo 0 || echo 1)" "the missing count did not reach the decision"
ok "  ...and the state file carries the count, not just the verdict" \
   "$(python3 -c "
import json,sys
d=json.load(open('$SANDBOX/lstate.json'))
sys.exit(0 if str(d.get('missing_links')) == '2' else 1)
" && echo 0 || echo 1)" "state: $(head -c 160 "$SANDBOX/lstate.json" 2>/dev/null)"

if command -v jq >/dev/null 2>&1; then
  rm -f "$SANDBOX/state.json"
  env MEMORY_INDEX_PATH="$BIG" MEMORY_INDEX_STATE="$SANDBOX/state.json" /bin/bash "$GATE" >/dev/null 2>&1
  J1="$(state max_seen)"
  env MEMORY_INDEX_PATH="$SMALL" MEMORY_INDEX_STATE="$SANDBOX/state.json" /bin/bash "$GATE" >/dev/null 2>&1
  ok "the jq path agrees with the fallback (same peak carried)" \
     "$([ "$(state max_seen)" = "$J1" ] && echo 0 || echo 1)" "jq path lost the peak: $J1 -> $(state max_seen)"
else
  echo "NOTE: jq is absent on this host, so the jq path was NOT measured."
  echo "      That is the condition the fallback exists for, and it was measured."
fi

echo
echo "$((N-FAILS))/$N passed  (gate under test: $GATE)"
[ "$FAILS" = "0" ] || exit 1
