#!/bin/bash
# c5296a52 -- the rapid-exit backoff must count RAPID EXITS, not log lines.
#
# channels.sh appends to store/channels-failures.log from several places: a rapid exit writes
# "rapid-exit after Ns", but a NORMAL startup also writes WARN lines there (isolated-config notes,
# a failed guard POST). The backoff counted `wc -l` over that file, so warnings inflated it: on
# 2026-09-18 this install's log held 2 lines, BOTH warnings and zero rapid-exits, which means the
# first real rapid exit would have counted as 3 (60s sleep) and two more warnings as 5 (300s).
#
# The test does NOT re-implement the counting: it lifts the FAIL_COUNT line OUT of channels.sh and
# evaluates that line against fixture logs. A second copy of the expression here would pass while
# the script drifts -- the thing under test has to be the script's own text.
# Run: bash scripts/__tests__/channels-rapid-exit-count.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

# The single line that computes the backoff counter, taken from the script itself.
COUNT_LINE="$(grep -E '^\s*FAIL_COUNT=\$\(' "$SRC" | head -1)"
if [ -z "$COUNT_LINE" ]; then
  echo "  FAIL: could not find the FAIL_COUNT line in $SRC (renamed? then this test is blind)"
  echo "PASS: $PASS  FAIL: $((FAIL + 1))"
  exit 1
fi

# $1 = label, $2 = log body, $3 = expected count
expect_count() {
  local label="$1" body="$2" want="$3" root got
  root="$(mktemp -d)"
  mkdir -p "$root/store"
  printf '%s' "$body" > "$root/store/channels-failures.log"
  got="$(INSTALL_DIR="$root" bash -c "$COUNT_LINE"'; echo "$FAIL_COUNT"' 2>/dev/null | tail -1)"
  rm -rf "$root"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "$want" "$got"; fi
}

expect_count "warnings alone do not raise the backoff counter" \
  '2026-09-18 09:36:37 channels.sh: WARN main-agent starting on SHARED ~/.claude
2026-09-18 09:36:37 channels.sh: WARN guard alert POST failed (HTTP 403)
' '0'

expect_count "one real rapid exit counts as one, next to two warnings" \
  '2026-09-18 09:36:37 channels.sh: WARN main-agent starting on SHARED ~/.claude
2026-09-18 09:36:37 channels.sh: WARN guard alert POST failed (HTTP 403)
2026-09-18 09:40:00 rapid-exit after 0s
' '1'

expect_count "five rapid exits still reach the 300s threshold (the backoff still works)" \
  '2026-09-18 09:40:00 rapid-exit after 0s
2026-09-18 09:41:00 rapid-exit after 0s
2026-09-18 09:42:00 rapid-exit after 1s
2026-09-18 09:43:00 rapid-exit after 0s
2026-09-18 09:44:00 rapid-exit after 2s
' '5'

expect_count "missing log file is zero, not an error" '' '0'

echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
