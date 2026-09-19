#!/usr/bin/env bash
# Run EVERY scripts/__tests__/*.test.py, discovered from the directory, not from
# a hand-kept list -- CITESZTLISTA919 (2026-09-19).
#
# Why a directory loop: the CI workflow used to name the python tests one by
# one, and the list drifted. Measured on develop f8d2db88: 23 test files in
# scripts/__tests__/, 4 of them in .github/workflows/test.yml. None of the four
# kartya-es-ertesites.py gate tests were among them, so the card tool's gates
# (title length, missing author, accent rule, homoglyph scan, typed clock) were
# only ever verified when someone remembered to run the tests by hand. A test
# that exists but never runs by itself is exactly the shape this repo keeps
# finding one level down: the gate is there, the evidence that it is still
# there is not.
#
# Contract:
#   - every *.test.py under scripts/__tests__/ runs, sorted, each in its own
#     python3 process, from the repo root, with a per-test timeout;
#   - a test SKIPS only if it is named in scripts/__tests__/.ci-skip with a
#     reason on the same line (name<TAB>reason). An unexplained skip is refused;
#   - exit 1 if ANY test fails or times out; the summary names each failure.
#     A new test file needs no wiring: dropping it into the directory is enough
#     (acceptance (b) of the card). Breaking a gate the tests cover turns the
#     whole step red (acceptance (a)).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT" || exit 1
TEST_DIR="scripts/__tests__"
SKIP_FILE="$TEST_DIR/.ci-skip"
TIMEOUT_S="${SCRIPT_TEST_TIMEOUT:-300}"

declare -a failed=() passed=() skipped=()
skip_reason() {  # name -> reason (empty if not skipped)
  [ -f "$SKIP_FILE" ] || return 0
  awk -F'\t' -v n="$1" '$1 == n { print $2 }' "$SKIP_FILE"
}
# An entry in the skip file with no reason is a config error, not a skip.
if [ -f "$SKIP_FILE" ]; then
  if awk -F'\t' '!/^#/ && NF > 0 && ($2 == "" || NF < 2) { bad = 1 } END { exit !bad }' "$SKIP_FILE"; then
    echo "run-script-tests: $SKIP_FILE has an entry without a reason (name<TAB>reason). Refusing to run."
    exit 1
  fi
fi

shopt -s nullglob
tests=("$TEST_DIR"/*.test.py)
shopt -u nullglob
if [ "${#tests[@]}" -eq 0 ]; then
  echo "run-script-tests: no *.test.py under $TEST_DIR -- refusing to report green on nothing."
  exit 1
fi

for t in "${tests[@]}"; do
  name="$(basename "$t")"
  reason="$(skip_reason "$name")"
  if [ -n "$reason" ]; then
    skipped+=("$name ($reason)")
    echo "::group::SKIP $name -- $reason"; echo "::endgroup::"
    continue
  fi
  echo "::group::$name"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$TIMEOUT_S" python3 "$t"; rc=$?
  else
    python3 "$t"; rc=$?
  fi
  echo "::endgroup::"
  if [ "$rc" -eq 0 ]; then
    passed+=("$name")
  else
    failed+=("$name (exit $rc)")
    echo "FAIL  $name (exit $rc)"
  fi
done

echo "---"
echo "run-script-tests: ${#tests[@]} discovered, ${#passed[@]} passed, ${#failed[@]} failed, ${#skipped[@]} skipped"
# ${arr[@]+"${arr[@]}"}: an EMPTY array under set -u is an "unbound variable"
# on bash < 4.4 (macOS ships 3.2); the idiom expands to nothing instead of dying.
for s in ${skipped[@]+"${skipped[@]}"}; do echo "  skipped: $s"; done
for f in ${failed[@]+"${failed[@]}"}; do echo "  FAILED:  $f"; done
[ "${#failed[@]}" -eq 0 ]
