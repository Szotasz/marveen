#!/bin/bash
# Contract tests for scripts/pre-modify-backup.sh -- the checksum tool and the
# exit code. Run: bash scripts/__tests__/pre-modify-backup-honest-exit.test.sh
#
# Two defects, measured on a macOS install the first time the script ran:
#   1. `sha256sum` is GNU coreutils and does not exist there, so every manifest
#      line was written with an EMPTY checksum column -- 26 paths, 0 sums. The
#      manifest exists for one purpose, comparing the live tree after an update
#      or a branch switch, and without sums it can only prove existence.
#   2. Eighteen "command not found" lines went to stderr, and the script then
#      printed "backup ok" and exited 0. The card asking whether to SCHEDULE
#      this script was open at the time: a scheduled caller reads the exit code,
#      so every round would have looked perfect while the drift check silently
#      did not exist.
#
# Hermetic: everything runs against a throwaway repo, never the live store. The
# "no checksum tool" case is produced by a curated PATH containing symlinks to
# the commands the script needs and nothing named sha256sum or shasum.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }
assert_contains() { case "$2" in *"$3"*) pass "$1" ;; *) fail "$1 (missing '$3')" ;; esac; }
assert_not_contains() { case "$2" in *"$3"*) fail "$1 (unexpected '$3')" ;; *) pass "$1" ;; esac; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/pre-modify-backup.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "pre-modify-backup: portable checksum and honest exit"
echo "===================================================="

# A throwaway install: a tiny database, one "personal" script, and the explicit
# list that names it. Nothing here touches the live store.
FAKE="$TMP/repo"
mkdir -p "$FAKE/scripts" "$FAKE/store"
cp "$SCRIPT" "$FAKE/scripts/"
sqlite3 "$FAKE/store/claudeclaw.db" "CREATE TABLE t(a); INSERT INTO t VALUES (1);"
printf '#!/bin/bash\necho proba\n' > "$FAKE/scripts/sajat.sh"
chmod +x "$FAKE/scripts/sajat.sh"
printf 'scripts/sajat.sh\n' > "$FAKE/store/personal-scripts.txt"

manifest_of() {
  local dir
  dir="$(ls -1dt "$FAKE/store/backups"/*/ 2>/dev/null | head -1)"
  [ -n "$dir" ] && cat "$dir/personal-scripts/MANIFEST.txt" 2>/dev/null
}

# ---------------------------------------------------------------------------
# 1. The ordinary case: a checksum tool exists (this host has one or the other).
# ---------------------------------------------------------------------------
echo ""
echo "(1) With a checksum tool available"
rm -rf "$FAKE/store/backups"
OUT="$(bash "$FAKE/scripts/pre-modify-backup.sh" proba 2>&1)"; RC=$?
assert_eq "exit 0 on a clean run" "0" "$RC"
assert_contains "says backup ok" "$OUT" "backup ok"
MAN="$(manifest_of)"
# The load-bearing assertion: a real 64-hex sum, not an empty column. The bug
# wrote a line that still LOOKED like a manifest entry, which is why "the file
# exists and has the right number of lines" was never enough.
case "$MAN" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*"  scripts/sajat.sh") pass "the manifest line carries a real checksum" ;;
  *) fail "the manifest line carries a real checksum" "got '$MAN'" ;;
esac
assert_not_contains "and is not recorded as NOSUM" "$MAN" "NOSUM"

# ---------------------------------------------------------------------------
# 2. NO checksum tool -- the measured macOS shape, reproduced by construction.
# ---------------------------------------------------------------------------
echo ""
echo "(2) With NO checksum tool on PATH"
STUB="$TMP/bin"; mkdir -p "$STUB"
for c in bash sqlite3 cp mkdir grep cut date du ls tail rm dirname basename git wc sed awk head sort uname; do
  for d in /usr/bin /bin /usr/local/bin /opt/homebrew/bin /usr/sbin; do
    if [ -x "$d/$c" ]; then ln -sf "$d/$c" "$STUB/$c"; break; fi
  done
done
# Empty-check on the stub itself: if the curated PATH lost a command the script
# needs, the run would fail for the WRONG reason and the case below would pass
# without ever reaching the code under test.
for need in sqlite3 grep cp; do
  [ -x "$STUB/$need" ] || fail "the curated PATH carries $need (otherwise this case proves nothing)"
done
if PATH="$STUB" command -v sha256sum >/dev/null 2>&1 || PATH="$STUB" command -v shasum >/dev/null 2>&1; then
  fail "the curated PATH really has no checksum tool"
else
  pass "the curated PATH really has no checksum tool"
fi

rm -rf "$FAKE/store/backups"
OUT="$(PATH="$STUB" /usr/bin/env bash "$FAKE/scripts/pre-modify-backup.sh" kontroll 2>&1)"; RC=$?
# The snapshot must still be taken -- a missing checksum is a lighter event than
# a failed backup, and collapsing the two would trade one silent failure for a
# louder but equally wrong one.
SNAP="$(ls -1dt "$FAKE/store/backups"/*/ 2>/dev/null | head -1)"
assert_eq "the snapshot is still written" "yes" "$([ -f "$SNAP/claudeclaw.db" ] && echo yes || echo no)"
assert_not_contains "it does NOT report a clean run" "$OUT" "backup ok"
assert_contains "it says the manifest is incomplete" "$OUT" "backup INCOMPLETE"
assert_contains "and names the missing tool" "$OUT" "no checksum tool found"
if [ "$RC" != 0 ]; then
  pass "the exit code is non-zero (a scheduled caller reads this, not stderr)"
else
  fail "the exit code is non-zero" "got 0 -- the silent-success bug is back"
fi
assert_contains "the manifest records NOSUM rather than a blank column" "$(manifest_of)" "NOSUM  scripts/sajat.sh"

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
