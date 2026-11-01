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
# The fixture DB is seeded through python3 stdlib, not the sqlite3 CLI, which
# install-linux.sh does not install (7ac77433). What the SCRIPT under test does
# with or without sqlite3 is what the cases below measure; the seeding must not
# depend on it.
. "$REPO/scripts/__tests__/lib/sqlite-oracle.sh"

echo "pre-modify-backup: portable checksum and honest exit"
echo "===================================================="

# A throwaway install: a tiny database, one "personal" script, and the explicit
# list that names it. Nothing here touches the live store.
FAKE="$TMP/repo"
mkdir -p "$FAKE/scripts" "$FAKE/store"
cp "$SCRIPT" "$FAKE/scripts/"
oracle_exec "$FAKE/store/claudeclaw.db" "CREATE TABLE t(a); INSERT INTO t VALUES (1);"
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
# without ever reaching the code under test. sqlite3 is linked when the host has
# it but is not required: without it the script takes the raw-copy branch.
for need in grep cp; do
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

# ---------------------------------------------------------------------------
# 3. sqlite3 present but FAILING -- #1565 item 7. Before the fix the script
#    printed "db: WARNING snapshot failed", then "backup ok" and exit 0 with no
#    database in the snapshot. A shim makes the CLI fail deterministically, so
#    this runs the same on a host with or without a real sqlite3; a missing
#    binary takes the very same branch.
# ---------------------------------------------------------------------------
echo ""
echo "(3) sqlite3 fails -> python3's backup API takes the consistent snapshot instead"
SHIM="$TMP/bin-badsqlite"; mkdir -p "$SHIM"
printf '#!/bin/sh\necho "sqlite3: shim failure" >&2\nexit 1\n' > "$SHIM/sqlite3"
chmod +x "$SHIM/sqlite3"
rm -rf "$FAKE/store/backups"
OUT="$(PATH="$SHIM:$PATH" bash "$FAKE/scripts/pre-modify-backup.sh" nosqlite 2>&1)"; RC=$?
SNAP="$(ls -1dt "$FAKE/store/backups"/*/ 2>/dev/null | head -1)"
assert_eq "exit 0" "0" "$RC"
ROWS="$(oracle_query "${SNAP}claudeclaw.db" "SELECT count(*) FROM t" 2>/dev/null)"
assert_eq "the snapshot holds a readable copy of the db (row count)" "1" "$ROWS"
# Card 252ab361 (a): python3 IS an install dependency and its sqlite3 backup API
# takes the same consistent snapshot the CLI's .backup does, so a missing or
# failing CLI no longer means a raw, possibly torn copy.
assert_contains "the run says the snapshot is consistent, through python3" "$OUT" "consistent snapshot ok (python3"
assert_contains "and the closing line names that db mode" "$OUT" "db: python3 sqlite3 backup"
assert_not_contains "no raw copy was needed" "$OUT" "no sqlite3 snapshot"

echo ""
echo "(3b) sqlite3 AND python3 fail -> the raw copy is the last resort, and the run says so"
printf '#!/bin/sh\necho "python3: shim failure" >&2\nexit 1\n' > "$SHIM/python3"
chmod +x "$SHIM/python3"
rm -rf "$FAKE/store/backups"
OUT="$(PATH="$SHIM:$PATH" bash "$FAKE/scripts/pre-modify-backup.sh" nopython 2>&1)"; RC=$?
rm -f "$SHIM/python3"
SNAP="$(ls -1dt "$FAKE/store/backups"/*/ 2>/dev/null | head -1)"
assert_eq "exit 0: a raw copy IS a recoverable snapshot" "0" "$RC"
ROWS="$(oracle_query "${SNAP}claudeclaw.db" "SELECT count(*) FROM t" 2>/dev/null)"
assert_eq "the snapshot holds a readable copy of the db (row count)" "1" "$ROWS"
assert_contains "the run says it is NOT a consistent snapshot" "$OUT" "no sqlite3 snapshot"
assert_contains "and the closing line names the db mode" "$OUT" "db: raw db+wal+shm copy"

# ---------------------------------------------------------------------------
# 4. The db cannot be captured at all -> loud, non-zero, and no rotation.
# ---------------------------------------------------------------------------
echo ""
echo "(4) db not capturable -> BACKUP INCOMPLETE, exit 1, good snapshots kept"
rm -rf "$FAKE/store/backups"; mkdir -p "$FAKE/store/backups"
for i in 01 02 03 04 05 06 07 08 09 10; do
  mkdir -p "$FAKE/store/backups/20000101-0000$i-old"
  touch -t "200001010000.$i" "$FAKE/store/backups/20000101-0000$i-old"
done
chmod 000 "$FAKE/store/claudeclaw.db"
if [ -r "$FAKE/store/claudeclaw.db" ]; then
  chmod 644 "$FAKE/store/claudeclaw.db"
  echo "  SKIP: running as root, an unreadable db cannot be produced -- case (4) NOT measured"
else
  OUT="$(PATH="$SHIM:$PATH" bash "$FAKE/scripts/pre-modify-backup.sh" unreadable 2>&1)"; RC=$?
  chmod 644 "$FAKE/store/claudeclaw.db"
  assert_eq "exit 1" "1" "$RC"
  assert_contains "says BACKUP INCOMPLETE" "$OUT" "BACKUP INCOMPLETE"
  assert_contains "and names the database" "$OUT" "claudeclaw.db"
  assert_not_contains "never says backup ok" "$OUT" "backup ok"
  assert_eq "no old snapshot was pruned for an incomplete one (10 old + 1 new)" "11" \
    "$(ls -1d "$FAKE/store/backups"/*/ 2>/dev/null | wc -l | tr -d ' ')"
fi

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
