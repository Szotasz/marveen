#!/bin/bash
# PORTSTAT912: channel-watchdog.sh must read a file's mtime on BSD (macOS) and
# GNU (Linux) alike.
#
# Regression origin (2026-09-12): both call sites used `stat -c %Y`, which is
# GNU-only. On macOS it exits 1 with "illegal option -- c" and the old
# `|| echo 0` fallback turned that into mtime=0, so a BRAND NEW keepalive file
# measured as infinitely old:
#
#   ka_mtime=0 -> age=1789213088s vs STALE_SECONDS=900 -> STALE=true, every tick
#
# Installing the watchdog on a Mac would therefore not have protected the main
# agent; it would have respawned its channels pane every 5 minutes up to
# MAX_CONSECUTIVE. The same zero also defeats the respawn-grace gate (the brake
# meant to stop exactly that storm), so the two failures compound.
#
# The assertions run against the SHIPPED script through its `--file-mtime`
# debug entry point, so this measures the code the timer runs, not a copy.
#
# Red-capability is not assumed, it is measured on every run: the last case
# proves that a single-form implementation is genuinely wrong on THIS host, so
# the passing cases above it cannot be passing for free. On macOS the broken
# form is the GNU one (the actual regression); on Linux it is the BSD one.
# Run: bash scripts/__tests__/channel-watchdog-mtime.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="${WATCHDOG_BIN:-$INSTALL_DIR/scripts/channel-watchdog.sh}"

echo "channel-watchdog.sh portable mtime (PORTSTAT912)"
echo "  source under test: $WATCHDOG"
echo "  platform: $(uname -s)"

# An mtime oracle that shares no code with the thing under test.
mtime_oracle() { python3 -c 'import os,sys; print(int(os.stat(sys.argv[1]).st_mtime))' "$1" 2>/dev/null; }
helper_mtime() { bash "$WATCHDOG" --file-mtime "$1" 2>/dev/null; }

if ! command -v python3 >/dev/null 2>&1; then
  fail "prerequisite: an independent mtime oracle" "python3 on PATH" "absent"
  echo; echo "  $PASS passed, $FAIL failed"; exit 1
fi

BOX="$(mktemp -d -t portstat912)"
trap 'case "$BOX" in *portstat912*) rm -rf "$BOX" ;; esac' EXIT

# --- positive control: the debug entry point exists at all -------------------
# Without it every case below would read an empty string and could never fail
# in a way that means anything.
probe="$(helper_mtime "$INSTALL_DIR/scripts/channel-watchdog.sh")"
case "$probe" in
  ''|*[!0-9]*) fail "the --file-mtime entry point answers with a number" "digits" "[$probe]" ;;
  *)           pass "the --file-mtime entry point answers with a number" ;;
esac

# --- case 1: a fresh, existing file ------------------------------------------
# The regression in one assertion: a file created a moment ago must NOT read 0.
fresh="$BOX/.channel-keepalive"
: > "$fresh"
got="$(helper_mtime "$fresh")"
want="$(mtime_oracle "$fresh")"
if [ "$got" = "0" ] || [ -z "$got" ]; then
  fail "fresh file: mtime is not 0" "a real epoch second" "[$got]"
else
  pass "fresh file: mtime is not 0"
fi
if [ -n "$got" ] && [ -n "$want" ] && [ "$got" -ge 0 ] 2>/dev/null; then
  drift=$(( got - want )); [ "$drift" -lt 0 ] && drift=$(( -drift ))
  if [ "$drift" -lt 2 ]; then
    pass "fresh file: within 2s of the real mtime (drift ${drift}s)"
  else
    fail "fresh file: within 2s of the real mtime" "drift < 2s" "${drift}s (got=$got want=$want)"
  fi
else
  fail "fresh file: within 2s of the real mtime" "comparable numbers" "got=[$got] want=[$want]"
fi

# --- case 2: an OLD file still reads old -------------------------------------
# Guards the other direction: a helper that always answered `now` would pass
# case 1 and silently disable staleness detection altogether.
old="$BOX/.channel-keepalive-old"
: > "$old"
touch -t 202601011200 "$old" 2>/dev/null || touch -d '2026-01-01 12:00' "$old" 2>/dev/null
got="$(helper_mtime "$old")"
want="$(mtime_oracle "$old")"
if [ "$got" = "$want" ] && [ "$got" != "0" ]; then
  pass "backdated file: the old mtime is reported, not now"
else
  fail "backdated file: the old mtime is reported, not now" "$want" "[$got]"
fi

# --- case 3: a missing file still falls back to 0 ----------------------------
# The historical contract: unknown means "act", not "crash".
got="$(helper_mtime "$BOX/does-not-exist")"
if [ "$got" = "0" ]; then
  pass "missing file: falls back to 0"
else
  fail "missing file: falls back to 0" "0" "[$got]"
fi

# --- case 4: the red-capable control -----------------------------------------
# Exactly one of the two single-form implementations is wrong on any given
# host. Naming which one, on every run, is what keeps the cases above from
# being green for free -- and it is the pre-fix expression verbatim, including
# its `|| echo 0` fallback.
gnu_form="$(stat -c %Y "$fresh" 2>/dev/null || echo 0)"
bsd_form="$(stat -f %m "$fresh" 2>/dev/null || echo 0)"
truth="$(mtime_oracle "$fresh")"
broken=""
[ "$gnu_form" != "$truth" ] && broken="$broken stat-c(GNU)=[$gnu_form]"
[ "$bsd_form" != "$truth" ] && broken="$broken stat-f(BSD)=[$bsd_form]"
if [ -n "$broken" ]; then
  pass "single-form control: wrong here ->$broken (truth=$truth), so the cases above can go red"
else
  fail "single-form control: at least one form must be wrong here" \
       "a broken single form to prove red-capability" "both forms agreed ($truth)"
fi

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
