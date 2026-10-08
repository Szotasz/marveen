#!/bin/bash
# Does the channel-image-resize hook still refuse to be a silent no-op?
#
# WHY THIS EXISTS (2026-09-21, #1565 item 4). The hook parsed its stdin with
# `jq ... 2>/dev/null`. jq is not installed and is not an installer dependency,
# so tool_name came back EMPTY, the next line said `[ "$TOOL_NAME" = "Read" ] ||
# exit 0`, and the hook exited 0 with no output on every single Read -- while
# being registered in TWO settings files, one of them the global one. Behind it
# sat a second swallow, `sips -Z 1024 ... || true`, macOS-only and absent here,
# which would have let the hook announce "was 900000B, now 900000B" as a resize.
#
# The property pinned here is therefore NOT "the parser works". It is:
#   WHEN THE HOOK CANNOT DO ITS JOB, THE FAILURE IS VISIBLE.
# A hook that exits 0 with no output is indistinguishable from a hook that
# correctly had nothing to do, and that indistinguishability is the whole bug.
# So every case below asserts one of two things: a LOUD failure (non-zero +
# stderr) or a DELIBERATE, understood silence -- never an ambiguous one.
#
# Case (0) is a control: the pre-fix parser is reconstructed and must produce
# the silent no-op. Without it a green run here proves only that today's code
# passes today's test, not that the test can see the bug it was written for.
#
# Everything runs in a throwaway temp tree. Nothing touches a real inbox.
set -uo pipefail
# Byte size, portable (GNU stat -c%s fails on macOS/BSD).
fsize() { wc -c < "$1" | tr -d ' '; }

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS  $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL  $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$INSTALL_DIR/scripts/hooks/channel-image-resize.sh"
# Absolute, because cases (3) and (4) run with a stripped PATH. First attempt
# used a bare `bash` there and measured 127 for 'bash: command not found' --
# a green-looking result that proved nothing about the hook.
BASH_BIN="$(command -v bash)"
BASE="$(mktemp -d -t chanimg.XXXXXX)"
trap 'rm -rf "$BASE"' EXIT

HOME_REAL="$HOME"                 # captured BEFORE the override: case (6) needs the real one
export HOME="$BASE/home"          # so the hook's log file cannot land in the real ~
mkdir -p "$HOME"

INBOX="$BASE/home/.claude/channels/telegram/inbox"
mkdir -p "$INBOX"

payload() { printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2"; }

# run_hook <payload> -> sets RC, OUT, ERR
run_hook() {
  OUT="$(printf '%s' "$1" | bash "$HOOK" 2>"$BASE/err")"
  RC=$?
  ERR="$(cat "$BASE/err")"
}

echo "channel-image-resize hook"
echo "========================="

# --- a big enough test image, or nothing below means anything ---------------
# Generated, not committed: a >500KB JPEG has to be noisy, and a noisy binary
# blob in the repo is worse than three lines of ffmpeg.
BIG="$BASE/big.jpg"
# The noise filter is not decoration: a clean testsrc2 at this size compresses
# to 332KB, below the hook's own threshold, and the suite would have measured
# nothing while looking green.
if ! ffmpeg -y -loglevel error -f lavfi -i "testsrc2=s=2400x2400:d=1" \
      -frames:v 1 -vf "noise=alls=60:allf=t+u" -q:v 1 "$BIG" >/dev/null 2>&1; then
  echo "SETUP FAILED: ffmpeg could not build the fixture image"
  exit 1
fi
BIG_SIZE=$(fsize "$BIG")
if [ "$BIG_SIZE" -le 524288 ]; then
  echo "SETUP FAILED: fixture is only ${BIG_SIZE}B, below the hook's 524288B threshold"
  exit 1
fi
echo "  (fixture: ${BIG_SIZE}B)"

fresh_image() {   # $1 = filename in the inbox
  rm -rf "$INBOX"; mkdir -p "$INBOX"
  cp "$BIG" "$INBOX/$1"
  echo "$INBOX/$1"
}

# --- (0) CONTROL: the pre-fix parser must show the bug ----------------------
echo
echo "(0) control -- the old jq parser is a silent no-op"
MUTANT="$BASE/mutant.sh"
{
  echo '#!/bin/bash'
  echo 'set -u'
  echo 'INPUT=$(cat)'
  echo 'TOOL_NAME=$(echo "$INPUT" | jq -r ".tool_name // empty" 2>/dev/null)'
  echo '[ "$TOOL_NAME" = "Read" ] || exit 0'
  echo 'echo "reached the work"'
} > "$MUTANT"
# The mutant runs on a curated PATH with no jq on it, so the control reproduces
# the bug's own precondition instead of borrowing it from the host. A GitHub
# runner ships jq; relying on its absence made this case fail there (#1621 CI).
BIN0="$BASE/bin-nojq"; mkdir -p "$BIN0"
p="$(command -v cat)" && ln -sf "$p" "$BIN0/cat"
IMG="$(fresh_image a.jpg)"
M_OUT="$(payload Read "$IMG" | PATH="$BIN0" "$BASH_BIN" "$MUTANT" 2>"$BASE/merr")"; M_RC=$?
if [ -e "$BIN0/jq" ]; then
  fail "the curated PATH for the control carries jq -- the control measures nothing"
elif [ "$M_RC" -eq 0 ] && [ -z "$M_OUT" ] && [ -z "$(cat "$BASE/merr")" ]; then
  pass "the old shape exits 0, says nothing, does nothing -- the test can see the bug"
else
  fail "the control did NOT reproduce the silent no-op (rc=$M_RC out='$M_OUT' err='$(cat "$BASE/merr")')"
fi

# --- (1) the happy path, measured on the file, not on the hook's word -------
echo
echo "(1) a real oversized inbox image"
IMG="$(fresh_image a.jpg)"
BEFORE=$(fsize "$IMG")
run_hook "$(payload Read "$IMG")"
AFTER=$(fsize "$IMG")
if [ "$RC" -eq 0 ]; then pass "exit 0"; else fail "exit $RC (stderr: $ERR)"; fi
if [ "$AFTER" -lt "$BEFORE" ]; then
  pass "the file on disk actually shrank ($BEFORE -> $AFTER)"
else
  fail "the file did NOT shrink ($BEFORE -> $AFTER) -- the resize is a second no-op"
fi
if [ -f "$INBOX/original/a.jpg" ] && [ "$(fsize "$INBOX/original/a.jpg")" -eq "$BEFORE" ]; then
  pass "the full-resolution original is preserved at the promised path"
else
  fail "the original is missing or not the original size"
fi
if [ -n "$OUT" ] && printf '%s' "$OUT" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  pass "stdout is valid JSON"
else
  fail "stdout is not valid JSON: $OUT"
fi
# The numbers in the note must be the numbers on disk. The old version printed
# ${SIZE} and ${NEW_SIZE} whether or not anything happened between them.
NOTE_OK=$(printf '%s' "$OUT" | AFTER="$AFTER" BEFORE="$BEFORE" python3 -c '
import json, os, sys
note = json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"]
print("yes" if (os.environ["BEFORE"]+"B") in note and (os.environ["AFTER"]+"B") in note else "no")
' 2>/dev/null)
if [ "$NOTE_OK" = "yes" ]; then
  pass "the note quotes the REAL before/after byte counts"
else
  fail "the note's byte counts do not match the file on disk"
fi
if [ -z "$(find "$INBOX" -maxdepth 1 -name '.channel-image-resize-*' -print -quit)" ]; then
  pass "no temp file left behind in the inbox"
else
  fail "a temp file was left in the inbox (it matches the inbox glob and would be Read next)"
fi
if [ -n "$ERR" ]; then pass "it reported what it did on stderr"; else fail "silent even on success"; fi

# --- (2) loud when the input cannot be understood ---------------------------
echo
echo "(2) unparseable input is LOUD, never 'nothing to do'"
for bad in 'not json at all' '' '[]' '{"tool_name":["Read"]}'; do
  run_hook "$bad"
  label="$(printf '%s' "${bad:-<empty>}" | head -c 24)"
  if [ "$RC" -ne 0 ] && [ -n "$ERR" ]; then
    pass "'$label' -> exit $RC + stderr"
  else
    fail "'$label' -> exit $RC, stderr='$ERR' (a silent pass on bad input is the original bug)"
  fi
  if [ "$RC" -eq 2 ]; then
    fail "'$label' -> exit 2 BLOCKS the Read; a broken hook must not stop a read"
  fi
done

# --- (3) loud when the interpreter itself is missing ------------------------
# The exact shape of the original bug, moved one tool to the left: if python3
# ever goes missing the same way jq did, the hook must NOT fall back to silence.
echo
echo "(3) no python3 -> loud, not silent"
BIN="$BASE/bin-nopy"; mkdir -p "$BIN"
for t in cat sed stat cp mv rm mkdir dirname basename date ffmpeg; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$BIN/$t"
done
IMG="$(fresh_image a.jpg)"
OUT="$(payload Read "$IMG" | PATH="$BIN" "$BASH_BIN" "$HOOK" 2>"$BASE/err")"; RC=$?; ERR="$(cat "$BASE/err")"
if [ "$RC" -eq 1 ] && [ -n "$ERR" ]; then
  pass "exit 1 (the hook's own loud exit) + stderr when the parser interpreter is gone"
else
  fail "exit $RC, stderr='$ERR' -- this is exactly how the jq bug looked"
fi

# --- (4) loud when there is no resizer at all -------------------------------
# On a machine with neither sips nor ImageMagick nor ffmpeg the hook cannot do
# its job. The old code would have said "resized" anyway.
echo
echo "(4) no resizer -> loud, and no false claim"
BIN2="$BASE/bin-noresize"; mkdir -p "$BIN2"
for t in cat sed stat cp mv rm mkdir dirname basename date python3; do
  p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$BIN2/$t"
done
IMG="$(fresh_image a.jpg)"
BEFORE=$(fsize "$IMG")
OUT="$(payload Read "$IMG" | PATH="$BIN2" "$BASH_BIN" "$HOOK" 2>"$BASE/err")"; RC=$?; ERR="$(cat "$BASE/err")"
if [ "$RC" -eq 1 ] && [ -n "$ERR" ]; then
  pass "exit 1 (the hook's own loud exit) + stderr naming the missing tools"
else
  fail "exit $RC, stderr='$ERR' -- a missing resizer must not pass as success"
fi
if [ -z "$OUT" ]; then
  pass "no additionalContext claiming a resize that did not happen"
else
  fail "it still emitted a note: $OUT"
fi
if [ "$(fsize "$IMG")" -eq "$BEFORE" ]; then
  pass "the image was left untouched"
else
  fail "the image changed although no resizer ran"
fi

# --- (4b) a resizer that IS there but fails ----------------------------------
# #1565 item 4, the macOS half: the old code ran `sips -Z 1024 ... || true` and
# then announced a resize no matter what sips did. A stub `sips` stands in for
# the real one (it is first in the hook's candidate order), so this runs the
# macOS branch on any box. Two ways sips can fail: a non-zero exit, and a zero
# exit that leaves the bytes as they were.
echo
echo "(4b) sips present but failing -> no false 'resized' claim"
for mode in rc1 noop; do
  BIN3="$BASE/bin-sips-$mode"; mkdir -p "$BIN3"
  for t in cat sed stat cp mv rm mkdir dirname basename date python3; do
    p="$(command -v "$t" 2>/dev/null)" && ln -sf "$p" "$BIN3/$t"
  done
  if [ "$mode" = rc1 ]; then
    printf '#!%s\necho "sips: stub failure" >&2\nexit 1\n' "$BASH_BIN" > "$BIN3/sips"
  else
    printf '#!%s\nexit 0\n' "$BASH_BIN" > "$BIN3/sips"
  fi
  chmod +x "$BIN3/sips"
  IMG="$(fresh_image a.jpg)"
  BEFORE=$(fsize "$IMG")
  OUT="$(payload Read "$IMG" | PATH="$BIN3" "$BASH_BIN" "$HOOK" 2>"$BASE/err")"; RC=$?; ERR="$(cat "$BASE/err")"
  if printf '%s' "$OUT" | grep -q 'auto-resized'; then
    fail "[$mode] the note claims a resize that sips did not do: $OUT"
  else
    pass "[$mode] no 'auto-resized' claim"
  fi
  if [ "$(fsize "$IMG")" -eq "$BEFORE" ]; then
    pass "[$mode] the image bytes are untouched"
  else
    fail "[$mode] the image changed although sips did nothing"
  fi
  if [ "$mode" = rc1 ]; then
    if [ "$RC" -eq 1 ] && [ -n "$ERR" ] && [ -z "$OUT" ]; then
      pass "[rc1] exit 1 + stderr, no additionalContext"
    else
      fail "[rc1] exit $RC, out='$OUT', stderr='$ERR' -- a failed sips must be loud"
    fi
  else
    if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q 'did NOT reduce'; then
      pass "[noop] exit 0 and the note says the ORIGINAL bytes are being read"
    else
      fail "[noop] exit $RC, out='$OUT' -- an unchanged file must be reported as unchanged"
    fi
  fi
done

# --- (5) the silences that ARE correct --------------------------------------
# These four must stay silent, otherwise every Read in the fleet gets noise --
# and noise is how the next real error gets ignored.
echo
echo "(5) understood input, genuinely nothing to do -> silent exit 0"
IMG="$(fresh_image a.jpg)"
run_hook "$(payload Edit "$IMG")"
if [ "$RC" -eq 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; then pass "a non-Read tool"; else fail "a non-Read tool: rc=$RC out='$OUT' err='$ERR'"; fi

mkdir -p "$INBOX/original"; cp "$BIG" "$INBOX/original/a.jpg"
run_hook "$(payload Read "$INBOX/original/a.jpg")"
if [ "$RC" -eq 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; then pass "a path already under original/"; else fail "original/: rc=$RC out='$OUT' err='$ERR'"; fi

run_hook "$(payload Read "$BASE/elsewhere.jpg")"
if [ "$RC" -eq 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ]; then pass "an image outside any channel inbox"; else fail "outside inbox: rc=$RC out='$OUT' err='$ERR'"; fi

IMG="$(fresh_image small.png)"
head -c 1000 /dev/urandom > "$IMG"
run_hook "$(payload Read "$IMG")"
if [ "$RC" -eq 0 ] && [ -z "$OUT" ] && [ -z "$ERR" ] && [ "$(fsize "$IMG")" -eq 1000 ]; then
  pass "a file under the 500KB threshold, left alone"
else
  fail "small file: rc=$RC out='$OUT' err='$ERR'"
fi

# --- (6) the hook is registered TWICE and both copies fire in parallel ------
# Measured live 2026-09-21: one Read produced TWO identical notes, because the
# project settings and the global settings each register this script and the
# runtime runs matching hooks concurrently. Deterministic ffmpeg hid the damage;
# the shape underneath is one instance replacing the file while the other reads
# it. Exactly one instance must do the work, the rest must fall into the
# UNDERSTOOD silence -- not into an error, and not into a second resize.
echo
echo "(6) two instances on the same file at the same instant"
IMG="$(fresh_image a.jpg)"
BEFORE=$(fsize "$IMG")
for n in 1 2 3; do
  ( payload Read "$IMG" | bash "$HOOK" >"$BASE/c$n.out" 2>"$BASE/c$n.err"; echo $? > "$BASE/c$n.rc" ) &
done
wait
NOTES=0; BADRC=0
for n in 1 2 3; do
  [ "$(cat "$BASE/c$n.rc")" -eq 0 ] || BADRC=$((BADRC+1))
  [ -s "$BASE/c$n.out" ] && NOTES=$((NOTES+1))
done
if [ "$BADRC" -eq 0 ]; then pass "all three exited 0"; else fail "$BADRC of 3 exited non-zero"; fi
if [ "$NOTES" -eq 1 ]; then
  pass "exactly one instance claimed the resize (the other two saw the work done)"
else
  fail "$NOTES of 3 emitted a note -- the duplicate registration is racing"
fi
AFTER=$(fsize "$IMG")
if [ "$AFTER" -lt "$BEFORE" ] && [ "$AFTER" -gt 0 ]; then
  pass "the file survived the race intact ($BEFORE -> $AFTER)"
else
  fail "the file is $AFTER B after three concurrent runs"
fi
if [ "$(fsize "$INBOX/original/a.jpg")" -eq "$BEFORE" ]; then
  pass "the original is the original, not a resized copy of itself"
else
  fail "the preserved original is $(fsize "$INBOX/original/a.jpg") B, expected $BEFORE"
fi
if [ -z "$(find "$INBOX" -maxdepth 1 -name '.channel-image-resize*' -print -quit)" ]; then
  pass "no lock or temp file left behind"
else
  fail "left behind: $(find "$INBOX" -maxdepth 1 -name '.channel-image-resize*')"
fi

# --- (7) the lock must not become a new way to be silently dead -------------
echo
echo "(7) a stale lock is stolen, a live one is loud"
IMG="$(fresh_image a.jpg)"
STALE="$INBOX/.channel-image-resize.lock-a.jpg"   # a FILE: the lock is O_EXCL, not mkdir
: > "$STALE"; perl -e 'my $t = time - 7200; utime $t, $t, $ARGV[0]' "$STALE"
run_hook "$(payload Read "$IMG")"
if [ "$RC" -eq 0 ] && [ "$(fsize "$IMG")" -lt "$(fsize "$BIG")" ]; then
  pass "a lock older than 60s is stolen, the work still happens"
else
  fail "a stale lock disabled the hook: rc=$RC (this is the no-op bug by another route)"
fi

IMG="$(fresh_image a.jpg)"
: > "$STALE"       # fresh mtime -> a live holder
START=$(date +%s)
run_hook "$(payload Read "$IMG")"
WAITED=$(( $(date +%s) - START ))
rm -f "$STALE"
if [ "$RC" -eq 1 ] && [ -n "$ERR" ]; then
  pass "a live lock -> exit 1 + stderr after ${WAITED}s, never a silent pass"
else
  fail "a live lock -> rc=$RC err='$ERR'"
fi

# --- (8) both registered copies, or the fix is half done --------------------
# The project copy is in .claude/settings.json; ~/.claude/hooks/ is registered
# in the GLOBAL settings and runs for the whole fleet. Fixing one and not the
# other looks exactly like a finished fix.
echo
echo "(8) the second registered copy"
GLOBAL_HOOK="$HOME_REAL/.claude/hooks/channel-image-resize.sh"
if [ -f "$GLOBAL_HOOK" ]; then
  if cmp -s "$HOOK" "$GLOBAL_HOOK"; then
    pass "~/.claude/hooks copy is byte-identical to the project copy"
  else
    fail "the two registered copies DIFFER -- one of them is still the old one"
  fi
else
  echo "  INFO  no ~/.claude/hooks copy on this machine; nothing to compare"
fi

echo
echo "========================="
echo "channel-image-resize: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
