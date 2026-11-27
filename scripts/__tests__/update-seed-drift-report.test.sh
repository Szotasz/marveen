#!/bin/bash
# The upgrade step must NAME a template key the live config lacks, not count it away.
#
# update.sh's refresh_untouched_seeds copies a shipped template over the live copy
# only when the live copy is untouched. A locally edited copy goes to the KEPT
# branch -- correct, because the local cadence and agent id are choices. But that
# branch only incremented a counter which was printed in aggregate, and only when
# some OTHER file happened to update. That is how the `preCheck` field from #1338
# never reached a locally edited ledger-live-drain config: hundreds of model turns a
# day on an empty script.
#
# This drives the REAL function out of update.sh -- extracted by name, so a rename
# fails the test rather than quietly stopping the measurement.
#
# Run: bash scripts/__tests__/update-seed-drift-report.test.sh

set -uo pipefail

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "update.sh seed refresh: drift reporting on the KEPT branch"

# Extract the functions the KEPT branch needs (v1.44 moved the branch into refresh_one_seed_file). If any of them is renamed or
# reshaped, the harness stops working and this test goes red -- which is the point.
# v1.51 (DOCKERSEEDREFRESH1108) moved the refresh into scripts/lib/seed-refresh.sh; update.sh keeps the seams
# (seed_copy_is_untouched, seed_tracked_files), so the harness sources the library and extracts the seams.
harness="$TMP/harness.sh"
{
    echo 'set -uo pipefail'
    echo 'YELLOW=""; NC=""; GREEN=""'
    echo 'SEED_REFRESH_UPDATED=0; SEED_REFRESH_KEPT=0; SEED_REFRESH_DRIFT=0; SCHED_REVIEW_NAMES=""'
    echo "source '$ROOT/scripts/lib/seed-refresh.sh'"
    echo 'sched_task_verified_ok() { return 2; }'
    for fn in seed_copy_is_untouched seed_tracked_files; do
        sed -n "/^${fn}()/,/^}/p" "$ROOT/update.sh"
    done
} > "$harness"
for fn in seed_copy_is_untouched seed_tracked_files; do
    grep -q "^${fn}()" "$harness" || { fail "could not extract ${fn} from update.sh"; echo; echo "  $PASS passed, $FAIL failed"; exit 1; }
done
for fn in refresh_one_seed_file refresh_untouched_seeds; do
    grep -q "^${fn}()" "$ROOT/scripts/lib/seed-refresh.sh" || { fail "${fn} is gone from scripts/lib/seed-refresh.sh"; echo; echo "  $PASS passed, $FAIL failed"; exit 1; }
done
pass "the library and update.sh's seams were found"

# A fake install with git history, because seed_copy_is_untouched asks git what we
# ever shipped at that path.
FAKE="$TMP/install"
mkdir -p "$FAKE/seed-scheduled-tasks/foo" "$FAKE/scripts"
cp "$ROOT/scripts/scheduled-task-drift-scan.sh" "$FAKE/scripts/"
printf 'MAIN_AGENT_ID=testagent\n' > "$FAKE/.env"
git -C "$FAKE" init -q
git -C "$FAKE" config user.email t@t
git -C "$FAKE" config user.name t
V1='{"schedule":"*/2 * * * *","agent":"{{MAIN_AGENT_ID}}","enabled":true}'
printf '%s\n' "$V1" > "$FAKE/seed-scheduled-tasks/foo/task-config.json"
git -C "$FAKE" add -A >/dev/null 2>&1
git -C "$FAKE" commit -qm v1 >/dev/null 2>&1
# The template gains the key, exactly as upstream #1338 did.
V2='{"schedule":"*/2 * * * *","agent":"{{MAIN_AGENT_ID}}","enabled":true,"preCheck":"{{PROJECT_ROOT}}/scripts/hooks/x.sh"}'
printf '%s\n' "$V2" > "$FAKE/seed-scheduled-tasks/foo/task-config.json"

run_refresh() { # <live-dir>
    INSTALL_DIR="$FAKE" MAIN_AGENT_ID=testagent bash -c "
        source '$harness'
        INSTALL_DIR='$FAKE'
        MAIN_AGENT_ID=testagent
        refresh_untouched_seeds seed-scheduled-tasks '$1' template
        echo \"COUNTS updated=\$SEED_REFRESH_UPDATED kept=\$SEED_REFRESH_KEPT drift=\$SEED_REFRESH_DRIFT\"
    " 2>&1
}

# Case A: the live copy was edited here (different cadence) -> KEPT, and the
# missing key must be named.
LIVE_A="$TMP/live-a"; mkdir -p "$LIVE_A/foo"
printf '%s\n' '{"schedule":"*/5 * * * *","agent":"testagent","enabled":true}' > "$LIVE_A/foo/task-config.json"
out="$(run_refresh "$LIVE_A")"
if echo "$out" | grep -q 'DRIFT foo: template defines "preCheck"'; then
    pass "a locally edited config is kept AND its missing key is named"
else
    fail "the KEPT branch stayed silent about the missing key: $out"
fi
if echo "$out" | grep -q 'kept=1 drift=1'; then
    pass "the drift counter separates this from an ordinary kept file"
else
    fail "counters wrong: $out"
fi
if grep -q '"schedule": *"\*/5' "$LIVE_A/foo/task-config.json" 2>/dev/null \
   || grep -q '"schedule":"\*/5' "$LIVE_A/foo/task-config.json"; then
    pass "the local cadence survived: reporting does not overwrite"
else
    fail "the live config was modified -- this must be report-only: $(cat "$LIVE_A/foo/task-config.json")"
fi

# Case B (control): the live copy is exactly what we shipped -> UPDATED, no drift
# line. Without this, case A could pass on a function that reports on everything.
LIVE_B="$TMP/live-b"; mkdir -p "$LIVE_B/foo"
INSTALL_DIR="$FAKE" MAIN_AGENT_ID=testagent bash -c "
    source '$harness'
    INSTALL_DIR='$FAKE'; MAIN_AGENT_ID=testagent
    git -C '$FAKE' show HEAD:seed-scheduled-tasks/foo/task-config.json | render_seed_template > '$LIVE_B/foo/task-config.json'
"
out="$(run_refresh "$LIVE_B")"
if echo "$out" | grep -q 'updated=1' && ! echo "$out" | grep -q 'DRIFT foo'; then
    pass "control: an untouched copy is refreshed silently, no drift line"
else
    fail "control failed -- the harness may be reporting on everything: $out"
fi
if grep -q 'preCheck' "$LIVE_B/foo/task-config.json"; then
    pass "control: the refreshed copy really did get the new key"
else
    fail "control: the refresh did not write the new template"
fi

# The summary in update.sh's run_seed_refresh: a drift alone must still print, even when no
# other file was updated (the old summary only spoke when something was updated). Extracted by
# name; the refresh itself is stubbed so only the summary logic runs.
summary_harness="$TMP/summary.sh"
{
    echo 'set -uo pipefail'
    echo 'GREEN=""; YELLOW=""; NC=""; ORANGE=""; SCHED_REVIEW_NAMES=""'
    echo 'refresh_untouched_seeds() { :; }'
    sed -n '/^run_seed_refresh()/,/^}/p' "$ROOT/update.sh"
} > "$summary_harness"
if ! grep -q '^run_seed_refresh()' "$summary_harness"; then
    fail "could not extract run_seed_refresh from update.sh"
else
    summary() { # <updated> <kept> <drift>
        INSTALL_DIR="$TMP/no-install" bash -c "
            source '$summary_harness'
            seed_refresh_groups() { SEED_REFRESH_UPDATED=$1; SEED_REFRESH_KEPT=$2; SEED_REFRESH_DRIFT=$3; }
            INSTALL_DIR='$TMP/no-install'
            SEED_REFRESH_UPDATED=0; SEED_REFRESH_KEPT=0; SEED_REFRESH_DRIFT=0
            run_seed_refresh
        " 2>&1
    }
    out="$(summary 0 1 1)"
    if printf '%s' "$out" | grep -q 'lemaradt egy uj sablon-kulcsrol' && printf '%s' "$out" | grep -q 'megtartva: 1'; then
        pass "a drift with no other update still prints the counts and the drift line"
    else
        fail "a drift alone was silent in the summary: $out"
    fi
    out="$(summary 0 1 0)"
    if [ -z "$out" ]; then
        pass "no update and no drift: the summary stays silent, as before"
    else
        fail "the summary spoke with nothing to report: $out"
    fi
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
