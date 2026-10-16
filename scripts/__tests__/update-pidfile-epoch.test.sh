#!/usr/bin/env bash
# The pidfile's start epoch is exactly 13 digits (ms), whatever `date` does (card 48612d05).
#
# Why: uutils coreutils (the Rust date, 0.8.0) ignores the width in
# `date +%s%3N` and prints the full nanoseconds, 19 digits. update.sh wrote
# that into store/update.pid, checkNoConcurrentUpdate read it as a start far
# in the future, and a stale pidfile behind a recycled pid never aged out.
#
# How: update_pidfile_epoch_ms is cut out of update.sh (from its definition
# line to the first line that is a lone "}") and run in a child bash with a
# stub `date` first on PATH: a GNU-like stub (13 digits for %3N), a
# uutils-like stub (19 digits), a BSD-like stub (%3N is no conversion), a
# 14-digit, an empty and a failing one; and once with this machine's own
# date. Every result must be exactly 13 digits, and each stub's expected
# value. A static check: the pidfile block calls the function, and no %3N
# call is left in update.sh outside it.
#
# Run:  bash scripts/__tests__/update-pidfile-epoch.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CEL="${UPDATE_SH:-$ROOT/update.sh}"
FAILS=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FN="$(awk '/^update_pidfile_epoch_ms\(\) \{$/{p=1} p{print} p && /^\}$/{exit}' "$CEL")"
if [ -z "$FN" ] || [ "$(printf '%s\n' "$FN" | tail -1)" != "}" ]; then
  echo "FAIL  update_pidfile_epoch_ms() not found in $CEL"
  echo "FAILED: 1"; exit 1
fi

# A stub date: `+%s%3N` prints the given text (or exits 1 for FAIL), `+%s`
# always prints 1791339884, anything else fails.
stub() {  # stub <name> <text for %3N, or FAIL>
  local d="$TMP/$1"
  mkdir -p "$d"
  printf '%s\n' '#!/usr/bin/env bash' \
    'case "$1" in' \
    "  +%s%3N) [ '$2' = FAIL ] && exit 1; printf '%s\n' '$2' ;;" \
    "  +%s) printf '%s\n' 1791339884 ;;" \
    '  *) exit 2 ;;' \
    'esac' > "$d/date"
  chmod +x "$d/date"
  printf '%s' "$d"
}

run_fn() {  # run_fn <dir to put first on PATH, or empty>
  if [ -n "$1" ]; then
    PATH="$1:$PATH" bash -c "$FN"$'\n''update_pidfile_epoch_ms'
  else
    bash -c "$FN"$'\n''update_pidfile_epoch_ms'
  fi
}

check_stub() {  # check_stub <label> <%3N text or FAIL> <expected>
  local got
  got="$(run_fn "$(stub "$1" "$2")")"
  if [[ "$got" =~ ^[0-9]{13}$ ]] && [ "$got" = "$3" ]; then
    echo "PASS  $1: $got"
  else
    echo "FAIL  $1: got '$got', want '$3' (exactly 13 digits)"
    FAILS=$((FAILS+1))
  fi
}

check_stub gnu-ms        1791339884828        1791339884828
check_stub uutils-ns     1791339884828136399  1791339884000
check_stub bsd-literal   1791339884%3N        1791339884000
check_stub fourteen      17913398848281       1791339884000
check_stub empty-output  ''                   1791339884000
check_stub date-fails    FAIL                 1791339884000

# This machine's own date: 13 digits, and within ten seconds of `date +%s`.
GOT="$(run_fn "")"
SEC="$(date +%s)"
if [[ "$GOT" =~ ^[0-9]{13}$ ]] && [ $(( GOT / 1000 - SEC )) -le 10 ] && [ $(( SEC - GOT / 1000 )) -le 10 ]; then
  echo "PASS  this machine's date ($(command -v date)): $GOT"
else
  echo "FAIL  this machine's date ($(command -v date)): got '$GOT', seconds now $SEC"
  FAILS=$((FAILS+1))
fi

# Static: the pidfile block writes the pid, then the function's line.
BLOCK="$(awk '/^\{$/{b=""; inb=1; next} inb && /^\} > "\$UPDATE_PIDFILE_TMP"$/{print b; exit} inb{b=b $0 "\n"}' "$CEL")"
if printf '%s' "$BLOCK" | grep -qx '  update_pidfile_epoch_ms' && printf '%s' "$BLOCK" | grep -qx '  echo "\$\$"'; then
  echo "PASS  the pidfile block calls update_pidfile_epoch_ms"
else
  echo "FAIL  the pidfile block does not call update_pidfile_epoch_ms"
  FAILS=$((FAILS+1))
fi
# No %3N call outside the function (comment lines do not count).
REST="$(awk '/^update_pidfile_epoch_ms\(\) \{$/{p=1} !p && !/^[[:space:]]*#/{print} p && /^\}$/{p=0}' "$CEL" | grep -c '%3N')"
if [ "$REST" -eq 0 ]; then
  echo "PASS  no %3N call outside update_pidfile_epoch_ms"
else
  echo "FAIL  $REST %3N call(s) outside update_pidfile_epoch_ms"
  FAILS=$((FAILS+1))
fi

[ "$FAILS" -eq 0 ] && { echo "OK: update-pidfile-epoch"; exit 0; }
echo "FAILED: $FAILS"; exit 1
