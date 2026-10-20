#!/bin/bash
# Contract tests for the portable file_mtime() helper in the watchdog scripts.
#
# Regression origin: channel-watchdog.sh, stuck-modal-guard.sh, watchdog.sh and
# host-restart-watchdog.sh read stamp mtimes with GNU-only
# `stat -c %Y f 2>/dev/null || echo 0`. On macOS (BSD stat) `-c` is an illegal
# option and the `|| echo 0` swallowed the error, so every stamp read as epoch 0
# ("last respawn was decades ago") and the respawn grace / backoff never applied.
#
# The helper is extracted from each script and evaluated on its own, so nothing
# here runs a watchdog, touches tmux, launchd, the dashboard or a real store.
# Run: bash scripts/__tests__/file-mtime-portable.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="channel-watchdog.sh stuck-modal-guard.sh watchdog.sh host-restart-watchdog.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
F="$TMP/stamp"
touch -t 202601021530.00 "$F"
# Independent oracle (not stat): perl's stat() is the same on Linux and macOS.
EXPECT="$(perl -e 'print((stat($ARGV[0]))[9])' "$F")"

echo "file_mtime portability tests"
echo "============================"

for s in $SCRIPTS; do
  echo ""
  echo "($s)"
  def="$(sed -n '/^file_mtime() {$/,/^}$/p' "$ROOT/scripts/$s")"
  if [ -z "$def" ]; then fail "$s defines file_mtime()" "no definition"; continue; fi
  got="$(eval "$def"; file_mtime "$F")"
  [ "$got" = "$EXPECT" ] && pass "real mtime of a touched file" || fail "real mtime of a touched file (want $EXPECT)" "$got"
  got="$(eval "$def"; file_mtime "$TMP/missing")"
  [ "$got" = "0" ] && pass "missing file -> 0" || fail "missing file -> 0" "$got"
  # No GNU-only mtime read may remain without the BSD fallback.
  bad="$(grep -nE 'stat -c ?.?%Y' "$ROOT/scripts/$s" | grep -v 'stat -f %m' | grep -v '^[0-9]*:#')"
  [ -z "$bad" ] && pass "no bare GNU-only stat -c %Y left" || fail "no bare GNU-only stat -c %Y left" "$bad"
done

echo ""
echo "============================"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
