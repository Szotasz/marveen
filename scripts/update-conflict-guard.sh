#!/usr/bin/env bash
# UPDATECONFLICT1105: repair what an update's conflicted auto-stash pop left in the install's tree, at the next start.
#
# Why here and not in update.sh: update.sh never re-executes itself, so the run that PULLS a fix to its own stash
# handling still runs the OLD copy (see the "no re-exec" note in update.sh). An update from v1.46.0 or older therefore
# still pops the stash the old way: a conflict leaves <<<<<<< markers in a tracked file, and a Python hook or script
# with markers is a SyntaxError that keeps the channel service down. That same old update.sh, however, restarts the
# services by running scripts/stop.sh and scripts/start.sh FROM DISK after the pull, so the start.sh it runs is
# already the new one. This guard, called first thing from start.sh, is the one fix that reaches those installs in
# the very update that brings it.
#
# What it does, and nothing more:
#   - Only in the install's own git tree (the toplevel must be the install dir); no git or no tree: one line, done.
#   - Clean tree: one `git diff-index HEAD` (plumbing, writes nothing), under a time limit. Nothing else runs.
#   - Unmerged (conflicted) paths are repaired ONLY when stash@{0} is a "marveen-update-auto-stash" entry (a conflicted
#     pop leaves it there), which holds the operator's own copy, and no merge/cherry-pick/revert/rebase of the
#     operator's is in progress (then: report only). Before the repair: the conflicted files and a `git diff HEAD`
#     patch go to an owner-only store/update-conflict-backup-<ts>-<rand>/; if that backup fails, nothing is repaired. The repair touches only the
#     unmerged paths: back to the HEAD (upstream) version, or removed when HEAD no longer has the file.
#   - Never: stash pop/apply/drop, reset --hard, clean. The stash entry stays and is named.
#   - A marker in a file that is NOT unmerged (for example one that was staged by hand) is only reported.
#   - It never blocks the start: start.sh calls it with `|| true`. A repaired .py/.json that still does not parse is
#     reported loudly (state repair_failed).
#   - The outcome goes to store/update-conflict-guard.json (atomic), which the dashboard turns into a banner.
#
# Usage: update-conflict-guard.sh <install dir>
set -u

DIR="${1:-}"
LIMIT="${UPDATE_CONFLICT_GUARD_TIMEOUT:-10}"
say() { echo "[update-conflict-guard] $*"; }

[ -n "$DIR" ] && [ -d "$DIR" ] || { say "no install dir given; skipped"; exit 0; }
DIR="$(cd "$DIR" && pwd -P)" || exit 0

# A time limit on every git call: coreutils timeout where present (Linux), else perl's alarm (macOS has perl, not
# timeout), else no limit.
tl() {
  if command -v timeout >/dev/null 2>&1; then timeout "$LIMIT" "$@"
  elif command -v perl >/dev/null 2>&1; then perl -e 'alarm shift; exec @ARGV or exit 127' "$LIMIT" "$@"
  else "$@"; fi
}
g() { tl git -C "$DIR" "$@"; }

command -v git >/dev/null 2>&1 || { say "git not found; skipped"; exit 0; }
TOP="$(g rev-parse --show-toplevel 2>/dev/null)" || { say "not a git tree; skipped"; exit 0; }
TOP="$(cd "$TOP" 2>/dev/null && pwd -P)"
[ "$TOP" = "$DIR" ] || { say "the git tree is not the install's own ($TOP); skipped"; exit 0; }

# The only call on a clean tree.
CHANGED="$(g diff-index HEAD --name-only 2>/dev/null)" || { say "git diff-index failed or timed out; skipped"; exit 0; }
[ -n "$CHANGED" ] || exit 0

UNMERGED="$(g ls-files -u 2>/dev/null | cut -f2- | sort -u)"

STATE_FILE="$DIR/store/update-conflict-guard.json"
write_state() { # write_state <state> <paths, one per line> [backup rel] [stash line]
  mkdir -p "$DIR/store" 2>/dev/null || return 0
  local tmp="$STATE_FILE.tmp.$$"
  if command -v python3 >/dev/null 2>&1 && printf '%s' "$2" | python3 -I -c '
import json, sys, time
state, backup, stash = sys.argv[1], sys.argv[2], sys.argv[3]
paths = [p for p in sys.stdin.read().split("\n") if p]
doc = {"state": state, "at": int(time.time() * 1000), "paths": paths}
if backup: doc["backup"] = backup
if stash: doc["stash"] = stash
print(json.dumps(doc, ensure_ascii=False))' "$1" "${3:-}" "${4:-}" > "$tmp" 2>/dev/null; then :
  else
    printf '{"state":"%s","at":%s000,"paths":[]}\n' "$1" "$(date +%s)" > "$tmp" 2>/dev/null || return 0
  fi
  chmod 600 "$tmp" 2>/dev/null; mv -f "$tmp" "$STATE_FILE" 2>/dev/null || rm -f "$tmp"
}
has_markers() { grep -qE '^(<<<<<<<|>>>>>>>)( |$)' "$DIR/$1" 2>/dev/null; }
parses() { # a .py or .json that does not parse is not repaired; other files (and no python3) are not checked
  command -v python3 >/dev/null 2>&1 || return 0
  case "$1" in
    *.py) python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])' "$DIR/$1" >/dev/null 2>&1 ;;
    *.json) python3 -I -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$DIR/$1" >/dev/null 2>&1 ;;
    *) return 0 ;;
  esac
}

# Markers outside the unmerged set: report only.
MARKER_ONLY=""
while IFS= read -r p; do
  [ -n "$p" ] && [ -f "$DIR/$p" ] || continue
  printf '%s\n' "$UNMERGED" | grep -qxF -- "$p" && continue
  has_markers "$p" && MARKER_ONLY="${MARKER_ONLY}${p}"$'\n'
done <<< "$CHANGED"

if [ -z "$UNMERGED" ]; then
  if [ -n "$MARKER_ONLY" ]; then
    say "WARNING: conflict markers in files that are not in a conflicted state; not repaired: $(printf '%s' "$MARKER_ONLY" | paste -sd, -)"
    write_state markers_only "$MARKER_ONLY"
  fi
  exit 0
fi

LIST="$(printf '%s' "$UNMERGED" | paste -sd, -)"

# The operator's own merge, cherry-pick, revert or rebase is in progress: its conflicts are theirs to resolve (an
# unmerged path may already hold their hand resolution). Report only. Dani's #2542 review: a merge in progress plus an
# OLD auto-stash entry from an earlier update made the guard overwrite a manual resolution.
GITDIR="$(g rev-parse --absolute-git-dir 2>/dev/null)"
for m in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  if [ -n "$GITDIR" ] && [ -e "$GITDIR/$m" ]; then
    say "WARNING: a git operation is in progress ($m); its conflicts are not repaired: $LIST"
    write_state refused_in_progress "$UNMERGED$MARKER_ONLY"
    exit 0
  fi
done

# A conflicted `git stash pop` keeps the popped entry at stash@{0}. So the operator's copy is the update's only when
# stash@{0} itself is a marveen-update-auto-stash entry; an older one further down belongs to another run.
STASH_LINE="$(g stash list -n 1 2>/dev/null)"
case "$STASH_LINE" in
  *marveen-update-auto-stash*) ;;
  *)
    say "WARNING: conflicted files, but stash@{0} is not a marveen-update-auto-stash entry holding the local copy; not touched: $LIST"
    write_state refused_no_stash "$UNMERGED$MARKER_ONLY"
    exit 0 ;;
esac

# Backup first; no backup, no repair. Owner-only (umask 077): the patch holds every local change. A unique suffix, so
# two runs within one second never share (or overwrite) a backup.
OLD_UMASK="$(umask)"
umask 077
TS="$(date +%Y%m%d-%H%M%S)"
backup_ok=1
B="$(mkdir -p "$DIR/store" 2>/dev/null && mktemp -d "$DIR/store/update-conflict-backup-$TS-XXXXXX" 2>/dev/null)" || backup_ok=0
[ -n "$B" ] && [ -d "$B" ] || backup_ok=0
BREL="store/$(basename "${B:-update-conflict-backup-$TS}")"
if [ "$backup_ok" = 1 ]; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ -e "$DIR/$p" ] || continue
    mkdir -p "$B/$(dirname "$p")" && cp "$DIR/$p" "$B/$p" || { backup_ok=0; break; }
  done <<< "$UNMERGED"
fi
[ "$backup_ok" = 1 ] && { g diff HEAD > "$B/local-changes.patch" 2>/dev/null || backup_ok=0; }
umask "$OLD_UMASK"   # the repaired files get the install's usual modes, not owner-only
if [ "$backup_ok" != 1 ]; then
  say "WARNING: the backup to $BREL failed; nothing repaired: $LIST"
  write_state backup_failed "$UNMERGED"
  exit 0
fi

# The repair: only the unmerged paths.
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if g cat-file -e "HEAD:$p" 2>/dev/null; then
    g checkout HEAD -- "$p" >/dev/null 2>&1 || say "WARNING: could not restore $p"
  else
    g rm -q -f --cached -- "$p" >/dev/null 2>&1; rm -f -- "$DIR/$p"
  fi
done <<< "$UNMERGED"

BAD=""
LEFT="$(g ls-files -u 2>/dev/null | cut -f2- | sort -u)"
while IFS= read -r p; do
  [ -n "$p" ] && [ -f "$DIR/$p" ] || continue
  if has_markers "$p" || ! parses "$p"; then BAD="${BAD}${p}"$'\n'; fi
done <<< "$UNMERGED"
if [ -n "$LEFT" ] || [ -n "$BAD" ]; then
  say "ERROR: after the repair these still do not parse or stay conflicted: $(printf '%s%s' "$LEFT" "$BAD" | sort -u | paste -sd, -) (backup: $BREL)"
  write_state repair_failed "$(printf '%s\n%s' "$LEFT" "$BAD")" "$BREL" "$STASH_LINE"
  exit 0
fi
say "repaired conflicted files back to the updated version: $LIST; local copies stay in '${STASH_LINE%%:*}' and in $BREL"
write_state repaired "$UNMERGED" "$BREL" "$STASH_LINE"
exit 0
