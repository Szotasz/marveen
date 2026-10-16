#!/usr/bin/env bash
# Pre-modification backup.
#
# RULE: before ANY system modification (schema change,
# feature deploy, config edit that the live service reads), snapshot the
# critical mutable state first. Code is already safe in git; this captures the
# state git does NOT track: the SQLite DB, the vault, and runtime config.
#
# Rolling retention: keep the newest $KEEP snapshots, prune the rest.
# Usage: scripts/pre-modify-backup.sh [label]
#   label is an optional short tag for the snapshot dir (e.g. "openrouter-ui").
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$REPO/store"

# Checksum tool, resolved ONCE and never assumed. sha256sum is GNU coreutils and
# does not exist on macOS, where the same job is `shasum -a 256`. This repo has
# learned that twice already -- limit-monitor.sh carries a comment about a bare
# md5sum returning an EMPTY hash there, and github-pr-monitor.sh one about BSD
# grep having no -P -- and this script still shipped the third instance: every
# manifest line here was written with an empty checksum on a mac while the run
# reported success. Empty is the dangerous shape, not absent: a manifest full of
# blank sums still looks like a manifest.
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  SHA_CMD=""
fi
BKDIR="$STORE/backups"
KEEP=10
LABEL="${1:-manual}"
TS="$(date +%Y%m%d-%H%M%S)"
DEST="$BKDIR/${TS}-${LABEL}"

mkdir -p "$DEST" || { echo "backup FAILED: cannot create $DEST" >&2; exit 1; }

# Consistent SQLite snapshot (NOT a raw cp -- the live dashboard may be mid-write).
#
# The sqlite3 CLI is NOT a dependency of install-linux.sh (ffmpeg, git, tmux,
# lsof, curl, python3, pipx, unzip, zstd), so the snapshot has to survive its
# absence (#1565 item 7). It did not: with no binary the call exited 127, the
# `||` turned that into a WARNING line, and the script still ended in
# "backup ok" + exit 0 with NO database in the snapshot. The same path hid a
# sqlite3 that was present but failed (locked db, full disk), so the fallback
# below covers BOTH through one branch -- what decides is the file that landed
# in $DEST, never whether a command could be found.
DB_MODE="no database in this install"
if [ -f "$STORE/claudeclaw.db" ]; then
  if command -v sqlite3 >/dev/null 2>&1 \
     && sqlite3 "$STORE/claudeclaw.db" ".backup '$DEST/claudeclaw.db'" 2>/dev/null \
     && [ -s "$DEST/claudeclaw.db" ]; then
    DB_MODE="sqlite3 .backup"
    echo "  db: consistent snapshot ok"
  else
    # Degraded fallback, the same one scripts/backup.sh uses without sqlite3:
    # copy the file trio as-is. A raw copy CAN be torn mid-write, so this is a
    # RECOVERABLE snapshot, not a consistent one -- the -wal carries the recent
    # writes and SQLite replays it on open; the -shm is only an index and is
    # rebuilt. Copying the db without its -wal would silently lose everything
    # written since the last checkpoint.
    rm -f "$DEST/claudeclaw.db" 2>/dev/null
    cp -p "$STORE/claudeclaw.db" "$DEST/claudeclaw.db" 2>/dev/null
    for _sfx in -wal -shm; do
      if [ -f "$STORE/claudeclaw.db$_sfx" ]; then
        cp -p "$STORE/claudeclaw.db$_sfx" "$DEST/claudeclaw.db$_sfx" 2>/dev/null
      fi
    done
    if [ -s "$DEST/claudeclaw.db" ]; then
      DB_MODE="raw db+wal+shm copy -- NOT a consistent snapshot"
      echo "  db: WARNING no sqlite3 snapshot -- copied db+wal+shm as-is (may be mid-write)"
    else
      DB_MODE="NOT CAPTURED"
      echo "  db: ERROR the database could NOT be captured" >&2
    fi
  fi
fi

# Small critical state git does not track. Explicit list -- store/ also holds
# ~1.7G of large/regenerable data we deliberately do NOT copy.
#
# The list lives in ONE variable because the closing check below reads it too;
# two hand-kept copies would drift and the check would stop covering whatever
# was added to only one of them.
CRITICAL_FILES="vault.json .vault-key .dashboard-token
openrouter-models.json agents-desired.json autonomy-config.json
auto-restart.json command-task-health.json schedule-last-run.json"
for f in $CRITICAL_FILES; do
  [ -f "$STORE/$f" ] && cp -p "$STORE/$f" "$DEST/" 2>/dev/null
done

# Personal, untracked scripts -- the ones git will NOT bring back.
#
# These hold install-specific data (chat ids, absolute home paths, account-bound
# token refreshers), so they are deliberately never pushed upstream -- which
# means git can never restore them, and this folder is the ONLY copy. On
# 2026-07-26 a branch switch silently deleted pre-modify-backup.sh itself (it
# lived only on a feature branch); nothing errored, it was simply gone.
#
# WHICH files count as personal is per-install, so the list is data, not code:
# store/personal-scripts.txt, one repo-relative path per line (# comments and
# blank lines ignored). With no such file we fall back to every untracked,
# executable script git already knows nothing about -- which is exactly the set
# at risk. Either way the manifest makes the post-update check possible: compare
# the live tree against personal-scripts/MANIFEST.txt after any update or
# branch switch.
PERSONAL_DIR="$DEST/personal-scripts"
PERSONAL_LIST="$STORE/personal-scripts.txt"
mkdir -p "$PERSONAL_DIR"
: > "$PERSONAL_DIR/MANIFEST.txt"
PERSONAL_MISSING=0
PERSONAL_SAVED=0
PERSONAL_NOSUM=0

if [ -f "$PERSONAL_LIST" ]; then
  PERSONAL_FILES="$(grep -vE '^\s*(#|$)' "$PERSONAL_LIST")"
else
  # Untracked files under scripts/ are by definition the ones git cannot restore.
  PERSONAL_FILES="$(git -C "$REPO" ls-files --others --exclude-standard -- scripts/ 2>/dev/null)"
fi

for rel in $PERSONAL_FILES; do
  if [ -f "$REPO/$rel" ]; then
    mkdir -p "$PERSONAL_DIR/$(dirname "$rel")"
    cp -p "$REPO/$rel" "$PERSONAL_DIR/$rel" 2>/dev/null
    sum=""
    [ -n "$SHA_CMD" ] && sum="$($SHA_CMD "$REPO/$rel" 2>/dev/null | cut -d' ' -f1)"
    if [ -n "$sum" ]; then
      printf '%s  %s\n' "$sum" "$rel" >> "$PERSONAL_DIR/MANIFEST.txt"
    else
      # The copy is safe; only the drift check is lost. Say WHICH, in the file
      # itself: a blank checksum column reads as a manifest, an explicit NOSUM
      # does not.
      printf 'NOSUM  %s\n' "$rel" >> "$PERSONAL_DIR/MANIFEST.txt"
      PERSONAL_NOSUM=$((PERSONAL_NOSUM + 1))
    fi
    PERSONAL_SAVED=$((PERSONAL_SAVED + 1))
  else
    # Only reachable via an explicit list: a named file that is already gone is
    # the exact loss this backup exists to catch, so say so loudly.
    printf 'MISSING  %s\n' "$rel" >> "$PERSONAL_DIR/MANIFEST.txt"
    PERSONAL_MISSING=$((PERSONAL_MISSING + 1))
  fi
done
if [ "$PERSONAL_MISSING" -gt 0 ]; then
  echo "  personal-scripts: WARNING $PERSONAL_MISSING file(s) ALREADY MISSING from the live tree ($PERSONAL_SAVED saved)"
else
  echo "  personal-scripts: $PERSONAL_SAVED saved + manifest"
fi
if [ "$PERSONAL_NOSUM" -gt 0 ]; then
  if [ -z "$SHA_CMD" ]; then
    echo "  personal-scripts: WARNING no checksum tool found (neither sha256sum nor shasum) -- $PERSONAL_NOSUM path(s) recorded as NOSUM"
  else
    echo "  personal-scripts: WARNING $PERSONAL_NOSUM path(s) could not be checksummed with '$SHA_CMD' -- recorded as NOSUM"
  fi
fi

# Code rollback reference (the code itself lives in git).
git -C "$REPO" rev-parse HEAD          > "$DEST/git-HEAD.txt"    2>/dev/null
git -C "$REPO" branch --show-current   > "$DEST/git-branch.txt"  2>/dev/null

# Verify what is in $DEST -- do NOT infer success from having reached this line.
# The old closing "backup ok" was bound to the script running through, not to
# the backup existing, so the reader who needed the truth (someone about to make
# a risky change) got the confirmation they came for while the database was
# absent. Checked BEFORE rotation: an incomplete snapshot must not push the
# oldest good one out of the retention window.
#
# personal-scripts is deliberately NOT part of this gate: a listed file that is
# already gone from the live tree is a warning about the tree, not a failed
# backup (and NOSUM keeps its own exit 3 below).
MISSING=""
if [ -f "$STORE/claudeclaw.db" ] && [ ! -s "$DEST/claudeclaw.db" ]; then
  MISSING="$MISSING claudeclaw.db"
fi
for f in $CRITICAL_FILES; do
  if [ -f "$STORE/$f" ] && [ ! -e "$DEST/$f" ]; then
    MISSING="$MISSING $f"
  fi
done

# Rotate: keep the newest $KEEP snapshot dirs, remove older ones. Skipped when
# this snapshot is incomplete (see above).
if [ -z "$MISSING" ] && [ -d "$BKDIR" ]; then
  ls -1dt "$BKDIR"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf "$old" && echo "  pruned old snapshot: $(basename "$old")"
  done
fi

SIZE="$(du -sh "$DEST" 2>/dev/null | cut -f1)"

# A snapshot that cannot restore the state outranks everything below.
if [ -n "$MISSING" ]; then
  echo "BACKUP INCOMPLETE: $DEST -- these are NOT in the snapshot:$MISSING" >&2
  echo "Do NOT proceed with the modification: this snapshot cannot restore the state." >&2
  exit 1
fi

# TWO events of different weight, kept apart. The snapshot above either happened
# or did not; the manifest is what makes a LATER comparison possible. A missing
# checksum must not throw away a good snapshot -- but it must not be reported as
# a clean run either, and until now it was: the run printed 18 "command not
# found" lines to stderr, then "backup ok" and exit 0. A scheduled caller reads
# the exit code, not the stderr, so every round would have looked perfect while
# the drift check quietly did not exist.
if [ "$PERSONAL_NOSUM" -gt 0 ]; then
  echo "backup INCOMPLETE: $DEST ($SIZE, retain newest $KEEP)"
  echo "  the snapshot IS written, but $PERSONAL_NOSUM manifest path(s) carry NO checksum:"
  echo "  the post-update comparison can only prove EXISTENCE for those, not content."
  exit 3
fi
echo "backup ok: $DEST ($SIZE, retain newest $KEEP, db: $DB_MODE)"
exit 0
