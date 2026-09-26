#!/bin/bash
# Regression test: scripts/backup.sh must not stage the archive under $TMPDIR.
# Run: bash scripts/__tests__/backup-stage-outside-tmpdir.test.sh
#
# macOS runs com.apple.bsd.dirhelper daily at 03:35 with
# CLEAN_FILES_OLDER_THAN_DAYS=3: it deletes $TMPDIR files whose atime is older
# than three days. backup.sh stages with `cp -pR`, which PRESERVES the source
# atime, so a rarely-read file (an agent CLAUDE.md, a channel .env, the
# dashboard token) lands in the stage already "old" and can be swept between the
# copy and the tar. Measured on a live install: every 03:35 run for eight nights
# failed its own manifest verification with 80-86 items missing; a manual run of
# the same script at another hour verified every entry.
#
# The sweep is reproduced here, not mocked away: a `cp` shim on PATH runs the
# real cp and then applies the dirhelper rule (`find <temp root> -atime +3
# -delete`) right after each copy. One source file carries an atime ten days
# in the past. The temp root is wherever `mktemp -t` really lands: on macOS
# that is the per-user confstr(_CS_DARWIN_USER_TEMP_DIR) directory and NOT
# $TMPDIR, so it is probed, not assumed. The sweep only ever deletes the one
# uniquely named file this test planted, never anything else in that shared
# directory, and it skips this test's own tree (the fixture and BACKUP_DIR sit
# under the same macOS temp root and are not what dirhelper's rule is about). If the stage lives under $TMPDIR, that file is gone before tar
# runs and backup.sh's verification exits 6; if the stage lives elsewhere, the
# file is in the archive and the script exits 0.
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

echo "backup.sh: staging survives the macOS \$TMPDIR sweep"
echo "===================================================="

FAKE="$TMP/repo"; FHOME="$TMP/home"; SWEEP="$TMP/sweep"; OUT="$TMP/out"; SHIM="$TMP/shim"
mkdir -p "$FAKE/scripts" "$FAKE/store" "$FHOME/.claude/skills/demo" \
  "$FHOME/.claude/scheduled-tasks/demo" "$SWEEP" "$OUT" "$SHIM"
# Where `mktemp -t` actually creates files under this environment.
TMPROOT="$(dirname "$(TMPDIR="$SWEEP" mktemp -u -t probe.XXXXXX)")"
PLANT="rarely-read-$$-$RANDOM.txt"
cp "$SCRIPT" "$FAKE/scripts/backup.sh"

# Load-bearing markers backup.sh insists on, plus one rarely-read file.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$FAKE/store/claudeclaw.db" 'CREATE TABLE t(x);'
else
  printf 'db' > "$FAKE/store/claudeclaw.db"
fi
printf 'x' > "$FHOME/.claude/skills/demo/SKILL.md"
printf 'x' > "$FHOME/.claude/scheduled-tasks/demo/SKILL.md"
printf 'rarely read content' > "$FAKE/store/$PLANT"
# atime ten days ago (mtime untouched): exactly what `cp -p` carries over.
touch -a -t "$(date -v-10d +%Y%m%d%H%M 2>/dev/null || date -d '10 days ago' +%Y%m%d%H%M)" \
  "$FAKE/store/$PLANT"

REAL_CP="$(command -v cp)"
cat > "$SHIM/cp" <<EOF
#!/bin/bash
"$REAL_CP" "\$@"; rc=\$?
find "$TMPROOT" -path "$TMP" -prune -o -type f -name "$PLANT" -atime +3 -print0 2>/dev/null | xargs -0 rm -f
exit \$rc
EOF
chmod +x "$SHIM/cp"

set +e
OUTPUT="$(cd "$FAKE" && HOME="$FHOME" TMPDIR="$SWEEP" BACKUP_DIR="$OUT" \
  PATH="$SHIM:$PATH" bash scripts/backup.sh 2>&1)"
RC=$?

if [ "$RC" -eq 0 ]; then pass "backup.sh exits 0 under the sweep"; else
  fail "backup.sh exited $RC under the sweep"; echo "$OUTPUT" | tail -15; fi

ARCHIVE="$(ls -1 "$OUT"/claudeclaw-*.tar.gz 2>/dev/null | head -1)"
if [ -n "$ARCHIVE" ] && tar -tzf "$ARCHIVE" | grep -qx "repo/store/$PLANT"; then
  pass "the old-atime file is in the archive"
else
  fail "the old-atime file is missing from the archive"
fi

if ls -d "$OUT"/.stage.* >/dev/null 2>&1; then
  fail "the staging dir was left behind in BACKUP_DIR"
else
  pass "the staging dir is cleaned up after the run"
fi

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
