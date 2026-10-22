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
#    binary takes the very same branch (with python3 kept off PATH).
# ---------------------------------------------------------------------------
echo ""
echo "(3) sqlite3 fails -> the db is still captured, and the run says how"
# A curated PATH: the commands the script needs and nothing else. python3 is
# kept OFF it, otherwise the python3 path rescues the run and this case stops
# testing the raw copy.
mkcurated() { # dir [extra cmds...]
  local dir="$1" c d; shift; mkdir -p "$dir"
  for c in bash cp mkdir grep cut date du ls tail rm dirname basename git wc sed awk head sort uname sha256sum shasum env "$@"; do
    for d in /usr/bin /bin /usr/local/bin /opt/homebrew/bin /usr/sbin; do
      if [ -x "$d/$c" ]; then ln -sf "$d/$c" "$dir/$c"; break; fi
    done
  done
}
SHIM="$TMP/bin-badsqlite"; mkcurated "$SHIM"
printf '#!/bin/sh\necho "sqlite3: shim failure" >&2\nexit 1\n' > "$SHIM/sqlite3"
chmod +x "$SHIM/sqlite3"
if PATH="$SHIM" command -v python3 >/dev/null 2>&1; then
  fail "the curated PATH really has no python3"
else
  pass "the curated PATH really has no python3"
fi
rm -rf "$FAKE/store/backups"
OUT="$(PATH="$SHIM" "$SHIM/bash" "$FAKE/scripts/pre-modify-backup.sh" nosqlite 2>&1)"; RC=$?
SNAP="$(ls -1dt "$FAKE/store/backups"/*/ 2>/dev/null | head -1)"
assert_eq "exit 0: a raw copy IS a recoverable snapshot" "0" "$RC"
ROWS="$(oracle_query "${SNAP}claudeclaw.db" "SELECT count(*) FROM t" 2>/dev/null)"
assert_eq "the snapshot holds a readable copy of the db (row count)" "1" "$ROWS"
assert_contains "the run says it is NOT a consistent snapshot" "$OUT" "WARNING no consistent snapshot"
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
  OUT="$(PATH="$SHIM" "$SHIM/bash" "$FAKE/scripts/pre-modify-backup.sh" unreadable 2>&1)"; RC=$?
  chmod 644 "$FAKE/store/claudeclaw.db"
  assert_eq "exit 1" "1" "$RC"
  assert_contains "says BACKUP INCOMPLETE" "$OUT" "BACKUP INCOMPLETE"
  assert_contains "and names the database" "$OUT" "claudeclaw.db"
  assert_not_contains "never says backup ok" "$OUT" "backup ok"
  assert_eq "no old snapshot was pruned for an incomplete one (10 old + 1 new)" "11" \
    "$(ls -1d "$FAKE/store/backups"/*/ 2>/dev/null | wc -l | tr -d ' ')"
fi

# Shared helper for the python3-path cases.
FS="$FAKE/store"
py_count() { python3 -c 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT COUNT(*) FROM t").fetchone()[0])' "$1" 2>/dev/null; }
NOSQLPY="$TMP/bin-nosqlite-py"; mkcurated "$NOSQLPY" python3

# ---------------------------------------------------------------------------
# 5. No sqlite3 CLI, python3 present -> consistent snapshot through python3.
# ---------------------------------------------------------------------------
echo ""
echo "(5) no sqlite3, python3 present -> python3 online backup, exit 0"
[ -x "$NOSQLPY/python3" ] && pass "the curated PATH carries python3" || fail "the curated PATH carries python3"
if PATH="$NOSQLPY" command -v sqlite3 >/dev/null 2>&1; then
  fail "the curated PATH really has no sqlite3"
else
  pass "the curated PATH really has no sqlite3"
fi
rm -rf "$FS/backups"
OUT="$(PATH="$NOSQLPY" "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" pyok 2>&1)"; RC=$?
SNAP="$(ls -1d "$FS/backups"/*-pyok/ | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "says backup ok" "$OUT" "backup ok"
assert_contains "names the python3 db mode" "$OUT" "db: python3 sqlite3 backup"
assert_not_contains "no raw-copy warning" "$OUT" "WARNING no consistent snapshot"
assert_eq "the snapshot holds the source row" "1" "$(py_count "${SNAP}claudeclaw.db")"

# ---------------------------------------------------------------------------
# 6. sqlite3 present but failing (leaves garbage), python3 present -> rescued.
# ---------------------------------------------------------------------------
echo ""
echo "(6) sqlite3 fails mid-write, python3 present -> rescued, exit 0"
TORN="$TMP/bin-tornsqlite"; mkdir -p "$TORN"
cat > "$TORN/sqlite3" <<'SH'
#!/bin/sh
dest="$(printf '%s' "$2" | sed -n "s/^\.backup '\(.*\)'$/\1/p")"
[ -n "$dest" ] && printf 'torn partial write' > "$dest"
if [ -n "$dest" ]; then for s in -journal -wal -shm; do printf 'stale' > "$dest$s"; done; fi
[ -n "${TORN_MARKER:-}" ] && : > "$TORN_MARKER"
echo "sqlite3: shim failure" >&2
exit 1
SH
chmod +x "$TORN/sqlite3"
rm -rf "$FS/backups"
export TORN_MARKER="$TMP/torn-ran"; rm -f "$TORN_MARKER"
OUT="$(PATH="$TORN:$PATH" bash "$FAKE/scripts/pre-modify-backup.sh" pyrescue 2>&1)"; RC=$?
SNAP="$(ls -1d "$FS/backups"/*-pyrescue/ | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "names the python3 db mode" "$OUT" "db: python3 sqlite3 backup"
assert_eq "the snapshot holds the source row" "1" "$(py_count "${SNAP}claudeclaw.db")"
assert_eq "the torn sqlite3 shim really ran" "yes" "$([ -e "$TORN_MARKER" ] && echo yes || echo no)"
for s in -journal -wal -shm; do
  assert_eq "no stale $s next to the snapshot" "no" "$([ -e "${SNAP}claudeclaw.db$s" ] && echo yes || echo no)"
done
unset TORN_MARKER

# ---------------------------------------------------------------------------
# 7. Source is not a database -> python3 fails, raw copy, WARNING, exit 0.
# ---------------------------------------------------------------------------
echo ""
echo "(7) python3 present, source not a database -> raw copy with WARNING, exit 0"
cp "$FS/claudeclaw.db" "$TMP/db.save"
printf 'not a database' > "$FS/claudeclaw.db"
rm -rf "$FS/backups"
OUT="$(PATH="$NOSQLPY" "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" badsrc 2>&1)"; RC=$?
SNAP="$(ls -1d "$FS/backups"/*-badsrc/ | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "WARNING line" "$OUT" "WARNING no consistent snapshot"
assert_contains "names the raw db mode" "$OUT" "db: raw db+wal+shm copy"
if cmp -s "$FS/claudeclaw.db" "${SNAP}claudeclaw.db"; then pass "snapshot is byte-identical to the source"; else fail "snapshot is byte-identical to the source"; fi
cp "$TMP/db.save" "$FS/claudeclaw.db"

# ---------------------------------------------------------------------------
# 8/9. Source stays locked -> only the deadline ends python3; falls to raw copy.
# ---------------------------------------------------------------------------
locked_case() { # label deadline [ignore-alrm|block-alrm]
  rm -rf "$FS/backups"; rm -f "$TMP/locked"
  python3 -c 'import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], isolation_level=None); c.execute("BEGIN EXCLUSIVE"); open(sys.argv[2],"w").close(); time.sleep(60)' \
    "$FS/claudeclaw.db" "$TMP/locked" &
  HOLDER=$!
  for _ in $(seq 50); do [ -e "$TMP/locked" ] && break; sleep 0.1; done
  assert_eq "the holder really took the lock" "yes" "$([ -e "$TMP/locked" ] && echo yes || echo no)"
  T0=$SECONDS
  if [ "${3:-}" = block-alrm ]; then
    OUT="$(PRE_MODIFY_BACKUP_PY_DEADLINE_S="$2" PATH="$NOSQLPY" "$NOSQLPY/python3" -c 'import os,signal,sys; signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGALRM}); os.execv(sys.argv[1], sys.argv[1:])' "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" "$1" 2>&1)"; RC=$?
  elif [ "${3:-}" = ignore-alrm ]; then
    # No coreutils `timeout` here: it resets SIGALRM for its child and would hide the bug.
    OUT="$( (trap '' ALRM; PRE_MODIFY_BACKUP_PY_DEADLINE_S="$2" PATH="$NOSQLPY" "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" "$1") 2>&1)"; RC=$?
  else
    OUT="$(PRE_MODIFY_BACKUP_PY_DEADLINE_S="$2" PATH="$NOSQLPY" "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" "$1" 2>&1)"; RC=$?
  fi
  ELAPSED=$((SECONDS - T0))
  kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
  assert_eq "exit 0" "0" "$RC"
  assert_contains "WARNING line" "$OUT" "WARNING no consistent snapshot"
  assert_eq "ended in under 20 s" "yes" "$([ "$ELAPSED" -lt 20 ] && echo yes || echo no)"
  if [ "$2" = 2 ]; then assert_eq "the deadline fired, not an early failure (>= 1 s)" "yes" "$([ "$ELAPSED" -ge 1 ] && echo yes || echo no)"; fi
}
echo ""
echo "(8) source held under an exclusive lock, deadline 2 s -> raw copy, exit 0"
locked_case locked 2
echo ""
echo "(9) deadline 0 must not disable the deadline"
locked_case zero 0

echo ""
echo "(10) deadline value malformed -> the 120 s default, still the python3 path, exit 0"
# The source stays locked for 5 s: the default deadline waits that out, while a
# malformed value read as the 1 s floor would kill the copy and degrade the run.
rm -rf "$FS/backups"; rm -f "$TMP/locked"
python3 -c 'import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], isolation_level=None); c.execute("BEGIN EXCLUSIVE"); open(sys.argv[2],"w").close(); time.sleep(5)' \
  "$FS/claudeclaw.db" "$TMP/locked" &
HOLDER=$!
for _ in $(seq 50); do [ -e "$TMP/locked" ] && break; sleep 0.1; done
assert_eq "the holder really took the lock" "yes" "$([ -e "$TMP/locked" ] && echo yes || echo no)"
OUT="$(PRE_MODIFY_BACKUP_PY_DEADLINE_S=2s PATH="$NOSQLPY" "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" badddl 2>&1)"; RC=$?
wait "$HOLDER" 2>/dev/null
SNAP="$(ls -1d "$FS/backups"/*-badddl/ | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "names the python3 db mode" "$OUT" "db: python3 sqlite3 backup"
assert_eq "the snapshot holds the source row" "1" "$(py_count "${SNAP}claudeclaw.db")"

echo ""
echo "(11) caller ignores SIGALRM, source locked, deadline 2 s -> raw copy, exit 0"
locked_case ignalrm 2 ignore-alrm

echo ""
echo "(11b) caller blocks SIGALRM, source locked, deadline 2 s -> raw copy, exit 0"
locked_case blkalrm 2 block-alrm

echo ""
echo "(11c) out-of-range deadline does not disable the python3 path"
rm -rf "$FS/backups"
OUT="$(PRE_MODIFY_BACKUP_PY_DEADLINE_S=99999999999 PATH="$NOSQLPY" "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" hugeddl 2>&1)"; RC=$?
SNAP="$(ls -1d "$FS/backups"/*-hugeddl/ | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "names the python3 db mode" "$OUT" "db: python3 sqlite3 backup"
assert_eq "the snapshot holds the source row" "1" "$(py_count "${SNAP}claudeclaw.db")"

echo ""
echo "(12) WAL-mode source with an open writer and uncheckpointed rows"
cp "$FS/claudeclaw.db" "$TMP/db.wal.save"
rm -rf "$FS/backups"; rm -f "$TMP/walready"
python3 -c 'import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], isolation_level=None); c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA wal_autocheckpoint=0"); c.execute("INSERT INTO t VALUES (2)"); open(sys.argv[2],"w").close(); time.sleep(60)' \
  "$FS/claudeclaw.db" "$TMP/walready" &
HOLDER=$!
for _ in $(seq 50); do [ -e "$TMP/walready" ] && break; sleep 0.1; done
assert_eq "the writer is ready" "yes" "$([ -e "$TMP/walready" ] && echo yes || echo no)"
assert_eq "the row is only in the -wal" "yes" "$([ -s "$FS/claudeclaw.db-wal" ] && echo yes || echo no)"
OUT="$(PATH="$NOSQLPY" "$NOSQLPY/bash" "$FAKE/scripts/pre-modify-backup.sh" walsrc 2>&1)"; RC=$?
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
SNAP="$(ls -1d "$FS/backups"/*-walsrc/ | head -1)"
assert_eq "exit 0" "0" "$RC"
assert_contains "names the python3 db mode" "$OUT" "db: python3 sqlite3 backup"
assert_eq "no -wal next to the snapshot" "no" "$([ -e "${SNAP}claudeclaw.db-wal" ] && echo yes || echo no)"
assert_eq "the snapshot alone has both rows" "2" "$(py_count "${SNAP}claudeclaw.db")"
cp "$TMP/db.wal.save" "$FS/claudeclaw.db"; rm -f "$FS/claudeclaw.db-wal" "$FS/claudeclaw.db-shm"

# ---------------------------------------------------------------------------
# 13. The function itself: a failed call clears a HOT journal and stale sidecars.
# ---------------------------------------------------------------------------
echo ""
echo "(13) a failed python3 call leaves no -journal/-wal/-shm next to the destination"
FN_START="$(grep -n '^_py_sqlite_backup() {' "$SCRIPT" | cut -d: -f1)"
FN_END="$(awk -v s="${FN_START:-0}" 'NR>=s && /^}$/ {print NR; exit}' "$SCRIPT")"
sed -n "${FN_START:-1},${FN_END:-0}p" "$SCRIPT" > "$TMP/pyfn.sh"
assert_eq "extracted whole function (first line)" "_py_sqlite_backup() {" "$(head -1 "$TMP/pyfn.sh")"
assert_eq "extracted whole function (last line)" "}" "$(tail -1 "$TMP/pyfn.sh")"
assert_contains "the copy call is inside it" "$(cat "$TMP/pyfn.sh")" "src.backup(dst)"
J="$TMP/hotj"; mkdir -p "$J"
python3 -c 'import sqlite3,sys,os; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA cache_size=1"); c.execute("CREATE TABLE x(a)"); c.commit(); c.execute("BEGIN"); [c.execute("INSERT INTO x VALUES (zeroblob(4000))") for _ in range(200)]; os._exit(0)' "$J/claudeclaw.db"
printf 'stale' > "$J/claudeclaw.db-wal"; printf 'stale' > "$J/claudeclaw.db-shm"
assert_eq "the fixture really has a non-empty -journal" "yes" "$([ -s "$J/claudeclaw.db-journal" ] && echo yes || echo no)"
printf 'not a database' > "$TMP/notdb"
( source "$TMP/pyfn.sh"; _py_sqlite_backup "$TMP/notdb" "$J/claudeclaw.db" ) 2>/dev/null; FRC=$?
assert_eq "the failing call returns non-zero" "yes" "$([ "$FRC" -ne 0 ] && echo yes || echo no)"
for s in -journal -wal -shm; do
  assert_eq "no $s left next to the destination" "no" "$([ -e "$J/claudeclaw.db$s" ] && echo yes || echo no)"
done
# mode=rw: a source that vanished between the caller's -f check and the call
# must fail, not be created as an empty database at the live path.
( source "$TMP/pyfn.sh"; _py_sqlite_backup "$TMP/gone.db" "$TMP/gone-out.db" ) 2>/dev/null; FRC=$?
assert_eq "a missing source fails the call" "yes" "$([ "$FRC" -ne 0 ] && echo yes || echo no)"
assert_eq "and is not created" "no" "$([ -e "$TMP/gone.db" ] && echo yes || echo no)"

echo ""
echo "==================================="
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" = 0 ] || exit 1
