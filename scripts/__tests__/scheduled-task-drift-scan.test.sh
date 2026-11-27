#!/bin/bash
# A drift guard that says the same thing on every install says nothing.
#
# The scan exists for one shape: a shipped template gained a key the LIVE config
# does not have. That is how the `preCheck` field from #1338 failed to arrive on a
# locally edited copy and cost hundreds of model turns a day on a script that
# surfaced nothing.
#
# Every OTHER difference here is deliberate: the live copies run under a different
# agent id, at cadences the owner tuned, with fields the templates never had. So
# this test asserts BOTH directions: the missing key is found, and the deliberate
# differences stay quiet. The second half is the one that decides whether the
# guard is still being read a month from now.
#
# Run: bash scripts/__tests__/scheduled-task-drift-scan.test.sh

set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCAN="$ROOT/scripts/scheduled-task-drift-scan.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "scheduled-task drift scan"

# A throwaway "install": the scan derives its repo root from its own path, so a
# copy in a temp tree gives fixture templates without touching this checkout.
FAKE="$TMP/fake-install"
mkdir -p "$FAKE/scripts" "$FAKE/scheduled-tasks" "$TMP/live"
cp "$SCAN" "$FAKE/scripts/"
printf 'MAIN_AGENT_ID=testagent\nWEB_PORT=3420\n' > "$FAKE/.env"

mk_template() { # <name> <json>
    mkdir -p "$FAKE/scheduled-tasks/$1"
    printf '%s\n' "$2" > "$FAKE/scheduled-tasks/$1/task-config.json"
}
mk_live() { # <name> <json>
    mkdir -p "$TMP/live/$1"
    printf '%s\n' "$2" > "$TMP/live/$1/task-config.json"
}
scan() { bash "$FAKE/scripts/scheduled-task-drift-scan.sh" --tasks-dir "$TMP/live" "$@" 2>&1; }

# (1) The case that cost the money: template gained preCheck, live copy has not.
mk_template drainy '{"schedule":"*/2 * * * *","agent":"marveen","enabled":true,"preCheck":"{{PROJECT_ROOT}}/scripts/hooks/x.sh"}'
mk_live     drainy '{"schedule":"*/5 * * * *","agent":"testagent","enabled":true}'
out="$(scan)"; status=$?
if [ "$status" -eq 1 ] && echo "$out" | grep -q 'DRIFT drainy: template defines "preCheck"'; then
    pass "a key missing from the live config is named, exit 1"
else
    fail "missing preCheck not reported (exit=$status): $out"
fi

# (2) The shape seen in the field was not an absent key but a null one -- which reads as
# "configured" to a human and as "off" to the runner.
mk_live drainy '{"schedule":"*/5 * * * *","agent":"testagent","enabled":true,"preCheck":null}'
out="$(scan)"; status=$?
if [ "$status" -eq 1 ] && echo "$out" | grep -q 'DRIFT drainy: template defines "preCheck"'; then
    pass "a null value counts as missing, not as configured"
else
    fail "preCheck:null passed as present (exit=$status): $out"
fi

# (3) Wired correctly, with the placeholder rendered and the agent id localised:
# this is the steady state, and it must be silent.
mk_live drainy "{\"schedule\":\"*/5 * * * *\",\"agent\":\"testagent\",\"enabled\":true,\"preCheck\":\"$FAKE/scripts/hooks/x.sh\"}"
out="$(scan)"; status=$?
if [ "$status" -eq 0 ] && [ -z "$out" ]; then
    pass "agent id and a rendered {{PROJECT_ROOT}} are not drift (silent, exit 0)"
else
    fail "expected silence on a correctly wired config (exit=$status): $out"
fi

# (4) Deliberate local policy: different cadence, different type, an extra field
# the template never had. Quiet by default, visible on demand.
mk_template policy '{"schedule":"*/15 * * * *","agent":"marveen","enabled":true,"type":"heartbeat"}'
mk_live     policy '{"schedule":"*/30 * * * *","agent":"testagent","enabled":true,"type":"task","forceSend":true}'
out="$(scan)"; status=$?
if [ "$status" -eq 0 ] && ! echo "$out" | grep -q 'DRIFT policy'; then
    pass "a tuned cadence, a changed type and an extra field are not drift"
else
    fail "local policy reported as drift (exit=$status): $out"
fi
vout="$(scan -v)"
if echo "$vout" | grep -q 'local policy: "schedule"' && echo "$vout" | grep -q 'local policy: "type"'; then
    pass "-v still lists the local differences, for when someone asks"
else
    fail "-v did not list the local differences: $vout"
fi

# (5) A template that is not installed here is not a finding -- adding tasks is
# the installer's job, not this scan's.
mk_template notinstalled '{"schedule":"0 4 * * *","agent":"marveen","enabled":true,"preCheck":"x"}'
out="$(scan)"; status=$?
if [ "$status" -eq 0 ]; then
    pass "a template with no installed copy is not reported as drift"
else
    fail "an uninstalled template was treated as drift: $out"
fi

# (6) It must refuse to pass silently when it cannot measure anything. A guard
# that returns 0 on an empty input set is the failure mode this scan exists to catch.
EMPTY="$TMP/empty-install"
mkdir -p "$EMPTY/scripts"
cp "$SCAN" "$EMPTY/scripts/"
bash "$EMPTY/scripts/scheduled-task-drift-scan.sh" --tasks-dir "$TMP/live" >/dev/null 2>&1
if [ "$?" -eq 2 ]; then
    pass "no templates at all is exit 2, not a clean bill of health"
else
    fail "an install with no templates reported success"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
