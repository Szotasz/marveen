#!/usr/bin/env bash
# Run the script-level tests in scripts/__tests__/ -- the ones vitest never sees.
#
# There were 19 of them and nothing ran them: `npm test` called vitest, which
# only knows about src/__tests__/*.ts. They passed when someone remembered to
# type the filename, which is the same silent no-op as a check that never
# fires -- green because nobody looked, not because it works.
#
# Two rules this runner follows, both learned from that failure mode:
#
#   It runs EVERY file before reporting, instead of stopping at the first red
#   one. "One test fails" and "eleven tests fail" call for different decisions,
#   and a runner that exits early cannot tell you which you are in.
#
#   An empty match is a FAILURE, not a pass. If the glob stops matching -- a
#   renamed directory, a changed convention -- a runner that exits 0 on zero
#   tests reports success for having done nothing, and that is exactly the
#   state this whole exercise exists to prevent.
#
# Naming convention (what gets picked up):
#   scripts/__tests__/*.test.py   run with python3
#   scripts/__tests__/*.test.sh   run with bash
# A file that does not match is NOT run. scripts/__tests__/test-voice-install.sh
# is deliberately outside it: it needs Docker, and an acceptance test that
# builds a container does not belong in the every-commit chain.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS_DIR="$ROOT/scripts/__tests__"
# One test must not be able to wedge the whole chain.
PER_TEST_TIMEOUT="${SCRIPT_TEST_TIMEOUT:-120}"

declare -a FAILED=()
passed=0
found=0

run_one() {
  local runner="$1" file="$2" name output rc
  name="$(basename "$file")"
  found=$((found + 1))
  output="$(cd "$ROOT" && timeout "$PER_TEST_TIMEOUT" "$runner" "$file" 2>&1)"
  rc=$?
  if [ $rc -eq 0 ]; then
    passed=$((passed + 1))
    printf '  ok   %s\n' "$name"
  else
    FAILED+=("$name")
    if [ $rc -eq 124 ]; then
      printf '  FAIL %s (timed out after %ss)\n' "$name" "$PER_TEST_TIMEOUT"
    else
      printf '  FAIL %s (exit %d)\n' "$name" "$rc"
    fi
    # Without the output a red run in a log is unactionable.
    printf '%s\n' "$output" | sed 's/^/       | /'
  fi
}

echo "script tests (scripts/__tests__)"

shopt -s nullglob
for f in "$TESTS_DIR"/*.test.py; do run_one python3 "$f"; done
for f in "$TESTS_DIR"/*.test.sh; do run_one bash "$f"; done
shopt -u nullglob

if [ "$found" -eq 0 ]; then
  echo "  no test files matched $TESTS_DIR/*.test.{py,sh}"
  echo "  refusing to report success for running nothing"
  exit 1
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n%d passed, %d FAILED: %s\n' "$passed" "${#FAILED[@]}" "${FAILED[*]}"
  exit 1
fi

printf '\n%d passed, 0 failed\n' "$passed"
