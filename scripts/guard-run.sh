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
#   2    usage error, or the script path does not exist / is not readable
#   129/130/143  HUP/INT/TERM: forwarded to the child, never swallowed; the
#        guard exits at once after the child, without draining the output
#
# Output capture is bounded: after the child exits, the guard waits at most
# GUARD_DRAIN_TIMEOUT whole seconds (default 3; counted on bash's SECONDS clock, so
# it can end up to one second early, never late) for the recording tees to finish,
# then kills them and checks the patterns on what was recorded so far. Known
# limit: a background descendant of the script (sleep 6 &, a daemon) that keeps
# stdout/stderr open can outlive the child; its later output is not recorded and
# not checked, and when the drain times out one line on stderr says the recorded
# output may be truncated. The exit code follows the normal rules.
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
[ -r "$1" ] || { echo "$SELF: script not found or not readable: $1" >&2; exit 2; }
DRAIN="${GUARD_DRAIN_TIMEOUT:-3}"
case "$DRAIN" in ''|*[!0-9]*) DRAIN=3 ;; esac

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

# Signalled: do not wait for the tees (a leftover descendant may hold the fifos
# open); cleanup kills them. Otherwise drain with a bound (bash 3.2 has no wait -t).
if [ "$SIG" -eq 0 ]; then
  SECONDS=0
  while [ "$SECONDS" -lt "$DRAIN" ] && { kill -0 "$TEE1" 2>/dev/null || kill -0 "$TEE2" 2>/dev/null; }; do
    sleep 0.1
  done
  if kill -0 "$TEE1" 2>/dev/null || kill -0 "$TEE2" 2>/dev/null; then
    echo "$SELF: output drain timed out after ${DRAIN}s (a background process holds the output); recorded output may be truncated" >&2
  fi
fi
kill "$TEE1" "$TEE2" 2>/dev/null
wait "$TEE1" "$TEE2" 2>/dev/null
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
