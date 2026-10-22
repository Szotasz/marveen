#!/bin/bash
# guard-run.sh - run a bash script and fail loudly when it died quietly.
#
# Why: under bash 3.2 (macOS /bin/bash), a script that has set an EXIT trap and
# then hits set -u / ${x:?} / a bad substitution / an arithmetic or readonly
# error stops half way but still exits 0. This wrapper runs the script, records
# what it printed and turns those cases into a non-zero exit.
#
# Usage:
#   guard-run.sh [--expect-line REGEX] <script> [arg...]
#
# Exit codes:
#   child's stdout/stderr pass through unchanged (and are recorded in a private
#   temp file that is removed on exit; nothing else is written anywhere).
#   0    child exited 0, no shell-error text seen, expected line (if any) seen
#   1    child exited non-zero (its code is printed), or it printed one of:
#        unbound variable | parameter null or not set | bad substitution |
#        syntax error in expression | readonly variable | and the bash 3.2
#        arithmetic wordings: operand expected | division by 0 |
#        value too great for base | invalid arithmetic operator
#   70   --expect-line given and no output line matched REGEX (egrep syntax)
#   129/130/143  HUP/INT/TERM: forwarded to the child, never swallowed
#
# The child runs as: ${GUARD_RUN_BASH:-bash} <script> [arg...]
# Compatible with bash 3.2.57 and newer, also under set -u.
set -u

SELF="guard-run.sh"
EXPECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-line)
      [ $# -ge 2 ] || { echo "$SELF: --expect-line needs a regex" >&2; exit 2; }
      EXPECT="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "$SELF: unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || { echo "usage: $SELF [--expect-line REGEX] <script> [arg...]" >&2; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/guard-run.XXXXXX")" || { echo "$SELF: mktemp failed" >&2; exit 2; }
chmod 700 "$TMP"
CAP="$TMP/capture"; : > "$CAP"
CHILD=""; TEE1=""; TEE2=""; SIG=0
cleanup() {
  [ -n "$TEE1" ] && kill "$TEE1" 2>/dev/null
  [ -n "$TEE2" ] && kill "$TEE2" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
# Forward the signal to the child; remember it so we exit 128+n afterwards.
trap 'SIG=129; [ -n "$CHILD" ] && kill -HUP "$CHILD" 2>/dev/null' HUP
# (bash starts background jobs with SIGINT ignored, so INT reaches the child as TERM)
trap 'SIG=130; [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null' INT
trap 'SIG=143; [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null' TERM

mkfifo "$TMP/out" "$TMP/err" || { echo "$SELF: mkfifo failed" >&2; exit 2; }
tee -a "$CAP" < "$TMP/out" &
TEE1=$!
tee -a "$CAP" < "$TMP/err" >&2 &
TEE2=$!
"${GUARD_RUN_BASH:-bash}" "$@" <&0 >"$TMP/out" 2>"$TMP/err" &
CHILD=$!

RC=0
wait "$CHILD" || RC=$?
# A trapped signal interrupts the first wait: wait again for the real exit.
if [ "$SIG" -ne 0 ]; then RC=0; wait "$CHILD" || RC=$?; fi
wait "$TEE1" 2>/dev/null; wait "$TEE2" 2>/dev/null
TEE1=""; TEE2=""

if [ "$SIG" -ne 0 ]; then
  echo "$SELF: signal received, child exit $RC" >&2
  exit "$SIG"
fi
if [ "$RC" -ne 0 ]; then
  echo "$SELF: FAILED: $1 exited with $RC" >&2
  exit 1
fi
if /usr/bin/grep -qF -e 'unbound variable' -e 'parameter null or not set' \
     -e 'bad substitution' -e 'syntax error in expression' -e 'readonly variable' \
     -e 'division by 0' -e 'operand expected' -e 'value too great for base' \
     -e 'invalid arithmetic operator' "$CAP"; then
  echo "$SELF: FAILED: $1 exited 0 but printed a bash error (see above); treating as failure" >&2
  exit 1
fi
if [ -n "$EXPECT" ] && ! /usr/bin/grep -qE -e "$EXPECT" "$CAP"; then
  echo "$SELF: FAILED: no output line matched expected /$EXPECT/" >&2
  exit 70
fi
exit 0
