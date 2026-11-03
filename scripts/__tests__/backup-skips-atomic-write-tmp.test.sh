#!/bin/bash
# Regression test: scripts/backup.sh must not put the transient temp file of an
# atomic write (store/<name>.tmp.<pid> and friends) on its manifest.
# Run: bash scripts/__tests__/backup-skips-atomic-write-tmp.test.sh
#
# Every writer that replaces a state file atomically creates a sibling temp file
# and renames it over the target a few milliseconds later (`<state>.tmp.<pid>`,
# `<ledger>.tmp-<pid>-<ts>`, `<file>.<pid>.<ts>.<hex>.tmp`, `<file>.tmp`). The
# manifest is built from a `find store -maxdepth 1` listing and the files are
# copied later, so a temp file listed in one moment is gone at the next. cp
# fails, STAGE_FAILS counts it, and the verification reports the same entry as
# missing from the archive: a complete, healthy backup exits 6 with
# "2 item(s) ... not in the archive" and raises the failure alert. Measured on a
# live install: one nightly run failed that way on a rename that happened
# between listing and copying. No data was lost; it is a race.
#
# The race is reproduced, not mocked away: a `cp` shim on PATH deletes the
# source file first when it is a store/ temp file, which is exactly what the
# writer's rename does, then runs the real cp. The expected behaviour is that a
# temp file never reaches the manifest, so there is nothing to lose.
#
# Hermetic: a throwaway repo and HOME under one temp dir, never the live store.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${BACKUP_SH_UNDER_TEST:-$REPO/scripts/backup.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "backup.sh: transient atomic-write temp files stay off the manifest"
echo "==================================================================="

FAKE="$TMP/repo"; FHOME="$TMP/home"; OUT="$TMP/out"; SHIM="$TMP/shim"
mkdir -p "$FAKE/scripts" "$FAKE/store" "$FHOME/.claude/skills/demo" \
  "$FHOME/.claude/scheduled-tasks/demo" "$OUT" "$SHIM"
cp "$SCRIPT" "$FAKE/scripts/backup.sh"
# backup.sh sources its literal archive-membership helper (card a8a92d55).
mkdir -p "$FAKE/scripts/lib" && cp "$(dirname "$SCRIPT")/lib/archive-list-has.sh" "$FAKE/scripts/lib/"

# Load-bearing markers backup.sh insists on.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$FAKE/store/claudeclaw.db" 'CREATE TABLE t(x);'
else
  printf 'db' > "$FAKE/store/claudeclaw.db"
fi
printf 'x' > "$FHOME/.claude/skills/demo/SKILL.md"
printf 'x' > "$FHOME/.claude/scheduled-tasks/demo/SKILL.md"

# The real state files, and the temp files their writers leave for a moment.
printf 'state' > "$FAKE/store/guard-state.json"
TMPS="guard-state.json.tmp.96781
ledger.json.tmp-4242-1700000000000
plain.json.tmp
guard-state.json.4242.1700000000000.deadbeef.tmp"
# Names that merely look similar and must stay in the backup.
KEEPS="template.json attmp.txt notes.tmpl"
printf '%s\n' "$TMPS" | while IFS= read -r n; do printf 'half-written' > "$FAKE/store/$n"; done
for n in $KEEPS; do printf 'keep' > "$FAKE/store/$n"; done

# The writer's rename, as seen by the script: the temp file is gone before the
# copy reaches it.
REAL_CP="$(command -v cp)"
cat > "$SHIM/cp" <<EOF
#!/bin/bash
for a in "\$@"; do
  case "\$a" in
    */store/*.tmp|*/store/*.tmp.*|*/store/*.tmp-*) rm -f "\$a" ;;
  esac
done
exec "$REAL_CP" "\$@"
EOF
chmod +x "$SHIM/cp"

set +e
OUTPUT="$(cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" PATH="$SHIM:$PATH" bash scripts/backup.sh 2>&1)"
RC=$?

if [ "$RC" -eq 0 ]; then pass "backup.sh exits 0 when store/ temp files vanish mid-run"; else
  fail "backup.sh exited $RC (a vanished temp file failed a healthy backup)"; echo "$OUTPUT" | tail -15; fi

if echo "$OUTPUT" | grep -q 'FAILED'; then
  fail "the run reported FAILED"; echo "$OUTPUT" | grep 'FAILED\|MISSING\|WARN' | head -5
else
  pass "no FAILED / MISSING line in the output"
fi

ARCHIVE="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
LIST="$TMP/archive.list"
[ -n "$ARCHIVE" ] && tar -tzf "$ARCHIVE" > "$LIST" 2>/dev/null || : > "$LIST"

if grep -qx "repo/store/guard-state.json" "$LIST"; then
  pass "the real state file is in the archive"
else
  fail "the real state file is missing from the archive"
fi

for n in $KEEPS; do
  if grep -qx "repo/store/$n" "$LIST"; then
    pass "look-alike name stays in the archive: $n"
  else
    fail "look-alike name was dropped from the archive: $n"
  fi
done

# Without the shim the temp files are really there at copy time. They are not
# worth a place in a restore either, so they stay out of the archive.
rm -rf "$OUT"; mkdir -p "$OUT"
printf '%s\n' "$TMPS" | while IFS= read -r n; do printf 'half-written' > "$FAKE/store/$n"; done
set +e
OUTPUT2="$(cd "$FAKE" && HOME="$FHOME" BACKUP_DIR="$OUT" bash scripts/backup.sh 2>&1)"
RC2=$?
ARCHIVE2="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
[ -n "$ARCHIVE2" ] && tar -tzf "$ARCHIVE2" > "$LIST" 2>/dev/null || : > "$LIST"

if [ "$RC2" -eq 0 ]; then pass "backup.sh exits 0 with the temp files present"; else
  fail "backup.sh exited $RC2 with the temp files present"; echo "$OUTPUT2" | tail -15; fi

printf '%s\n' "$TMPS" | while IFS= read -r n; do
  if grep -qx "repo/store/$n" "$LIST"; then echo "LEAK $n" >> "$TMP/leaks"; fi
done
if [ -s "$TMP/leaks" ]; then
  fail "temp files were archived: $(tr '\n' ' ' < "$TMP/leaks")"
else
  pass "none of the temp files is in the archive"
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
