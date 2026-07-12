#!/bin/bash
# Contract test for scripts/hooks/channel-inbox-drain.py.
# Run: bash scripts/__tests__/channel-inbox-drain.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$INSTALL_DIR/scripts/hooks/channel-inbox-drain.py"

echo "channel-inbox-drain tests"
echo "========================="

OUT="$(python3 "$HOOK" --self-test 2>&1)"
STATUS=$?
if [ "$STATUS" -eq 0 ]; then
  pass "self-test exits 0"
else
  fail "self-test exits $STATUS: $OUT"
fi

case "$OUT" in
  *"channel-inbox-drain self-test passed"*) pass "self-test reports success" ;;
  *) fail "self-test did not report success: $OUT" ;;
esac

echo ""
echo "========================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
