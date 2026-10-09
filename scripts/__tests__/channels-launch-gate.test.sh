#!/bin/bash
# Contract tests for the launch gate in scripts/channels.sh (LAUNCHGATE1008).
#
# Origin: an argument channels.sh does not know (a test calling a seam that
# only a newer version has) fell through every `if [ "${1:-}" = "--seam" ]`
# to the NORMAL launch and started a second main session on the live tmux
# server -- a second getUpdates poller on the owner's bot, 409, the live
# channel deaf until a restart. A checkout without .env launched the same way
# as "marveen-channels". The gate must:
#   - refuse any unknown argument with exit 2, nothing started,
#   - refuse a checkout without .env with exit 3, nothing started,
#   - let no argument and `restart` through (the installers' documented
#     manual restart), and a .env without MAIN_AGENT_ID (older installs).
#
# SAFE BY CONSTRUCTION: the script under test is a COPY cut right after the
# gate's end marker, with `echo LAUNCH-REACHED; exit 99` in place of the
# launch path. If the gate is broken (or mutated away), a run stops at that
# sentinel -- it can never reach tmux, claude or a kill. CHANNELS_BIN points
# the suite at another source (a mutant) to prove it can go red.
# Run: bash scripts/__tests__/channels-launch-gate.test.sh
set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$REPO/scripts/channels.sh}"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
MARKER='# LAUNCHGATE1008-END: everything below launches.'

echo "channels.sh launch gate (LAUNCHGATE1008)"
echo "========================================"

# Source pins: the marker exists exactly once, and nothing above it starts a
# session (the cut copy below is only as safe as this region is inert).
n="$(grep -cxF "$MARKER" "$SRC")"
if [ "$n" = "1" ]; then pass "the gate end marker appears exactly once"; else fail "the gate end marker appears exactly once" 1 "$n"; fi
above="$(awk -v m="$MARKER" '$0 == m {exit} {print}' "$SRC")"
# Any tmux command that changes a session (through "$TMUX", ${TMUX} or a literal tmux),
# any kill, and any network or detach helper above the gate fails the pin. A read-only
# `"$TMUX" list-panes` inside a seam is fine.
PIN_TMUX='("\$TMUX"|"\$\{TMUX\}"|\$\{TMUX\}|\$TMUX|(^|[^A-Za-z0-9_./-])tmux)[[:space:]]+(new-session|new|kill-[a-z]+|respawn-[a-z]+|send-keys|set-environment|attach[a-z-]*)'
PIN_OTHER='/bin/kill|(^|[^A-Za-z0-9_-])(kill[[:space:]]+-|pkill[[:space:]]|curl[[:space:]]|nohup[[:space:]]|setsid[[:space:]])|exec[[:space:]]+"?\$\{?CLAUDE'
hits="$(printf '%s\n' "$above" | grep -vE '^[[:space:]]*#' | grep -nE "$PIN_TMUX|$PIN_OTHER")"
if [ -n "$hits" ]; then
  fail "nothing at top level above the gate starts or kills a session" none "$(printf '%s' "$hits" | head -3)"
else
  pass "nothing at top level above the gate starts or kills a session"
fi
# the pin itself must catch each forbidden shape (a pin that matches nothing is decoration)
for shape in '"$TMUX" new-session -d -s x' '${TMUX} kill-session -t x' 'tmux send-keys -t x' \
             '$TMUX set-environment -g X 1' '/bin/kill 1' 'kill -TERM 1' 'curl -s http://x' \
             'nohup bash x' 'setsid bash x' 'exec "$CLAUDE" --channels'; do
  if printf '%s\n' "$shape" | grep -qE "$PIN_TMUX|$PIN_OTHER"; then pass "the pin catches: $shape"
  else fail "the pin catches: $shape" match none; fi
done
if printf '%s\n' '"$TMUX" list-panes -t x' | grep -qE "$PIN_TMUX|$PIN_OTHER"; then
  fail "the pin lets a read-only list-panes through" "no match" match
else
  pass "the pin lets a read-only list-panes through"
fi
[ "$n" = "1" ] || { echo ""; echo "passed: $PASS  failed: $FAIL"; exit 1; }

# $1 = fixture name, $2 = .env content ("-" = no .env), $3 = "nostore" for a fresh checkout
make_install() {
  local d="$TMPD/$1"
  mkdir -p "$d/scripts/lib"
  [ "${3:-}" = "nostore" ] || mkdir -p "$d/store"
  cp "$REPO"/scripts/lib/*.sh "$d/scripts/lib/" 2>/dev/null
  { printf '%s\n' "$above"; printf '%s\n' "$MARKER" 'echo LAUNCH-REACHED; exit 99'; } > "$d/scripts/channels.sh"
  [ "$2" = "-" ] || printf '%s\n' "$2" > "$d/.env"
  printf '%s' "$d"
}

# $1 = label, $2 = expected exit, $3 = install dir, $4.. = arguments
expect_exit() {
  local label="$1" want="$2" inst="$3"; shift 3
  local out rc
  out="$(cd "$TMPD" && CHANNELS_EXITS_LOG="$TMPD/exits.log" bash "$inst/scripts/channels.sh" "$@" 2>&1)"; rc=$?
  if [ "$rc" = "$want" ]; then pass "$label"; else fail "$label" "exit $want" "exit $rc ($(printf '%s' "$out" | tail -1))"; fi
  case "$want" in
    2|3) case "$out" in *LAUNCH-REACHED*) fail "$label: nothing started" "no launch" "LAUNCH-REACHED";; esac ;;
  esac
}

INST="$(make_install inst 'MAIN_AGENT_ID=gatetest')"
NOENV="$(make_install noenv -)"
NOID="$(make_install noid 'CHANNEL_PROVIDER=telegram')"

expect_exit "no argument launches (exit 99 = the sentinel)"            99 "$INST"
expect_exit "restart launches (the installers' documented hint)"       99 "$INST" restart
expect_exit "an unknown seam-like flag is refused"                     2  "$INST" --classify-some-future-seam
expect_exit "an unknown word is refused"                               2  "$INST" stop
expect_exit "restart with a suffix is refused (exact match only)"      2  "$INST" restartx
expect_exit "restart with an extra argument is refused (\$# counts)"   2  "$INST" restart now
expect_exit "an empty string argument is refused (\$# counts)"         2  "$INST" ""
expect_exit "an empty-looking argument with a space is refused"        2  "$INST" ' '
expect_exit "a seam above the gate still works (--exit-probe 5)" 5  "$INST" --exit-probe 5
expect_exit "no .env is refused, even without an argument"             3  "$NOENV"
expect_exit "no .env is refused with restart too"                      3  "$NOENV" restart
expect_exit "a .env without MAIN_AGENT_ID still launches (older installs)" 99 "$NOID"

# A fresh checkout (no store/): each refusal is exactly ONE stderr line -- the exit-log
# trap must not add "No such file" + "exit-log write FAILED" (measured on a real install).
FRESH="$(make_install fresh 'MAIN_AGENT_ID=gatetest' nostore)"
FRESHNOENV="$(make_install freshnoenv - nostore)"
for c in "unknown argument|$FRESH|--bogus" "no .env|$FRESHNOENV|"; do
  label="${c%%|*}"; rest="${c#*|}"; inst="${rest%%|*}"; arg="${rest#*|}"
  if [ -n "$arg" ]; then err="$(env -u CHANNELS_EXITS_LOG bash "$inst/scripts/channels.sh" "$arg" 2>&1 >/dev/null)"
  else err="$(env -u CHANNELS_EXITS_LOG bash "$inst/scripts/channels.sh" 2>&1 >/dev/null)"; fi
  n="$(printf '%s\n' "$err" | grep -c .)"
  if [ "$n" = "1" ]; then pass "fresh checkout, $label: exactly one stderr line"
  else fail "fresh checkout, $label: exactly one stderr line" 1 "$n ($(printf '%s' "$err" | tr '\n' '|'))"; fi
done
# ...but every OTHER exit stays loud without store/ (CHEXIT910): a seam exit warns
err="$(env -u CHANNELS_EXITS_LOG bash "$FRESH/scripts/channels.sh" --exit-probe 4 2>&1 >/dev/null)"
case "$err" in *"exit-log write FAILED"*) pass "a non-gate exit without store/ still warns";;
  *) fail "a non-gate exit without store/ still warns" "exit-log write FAILED" "$err";; esac
# ...and with store/ the gate refusal IS recorded (the trap is not switched off)
env -u CHANNELS_EXITS_LOG bash "$INST/scripts/channels.sh" --bogus >/dev/null 2>&1
if grep -q "exit code=2 " "$INST/store/channels-exits.log" 2>/dev/null; then pass "with store/ the refusal is recorded in the exit log"
else fail "with store/ the refusal is recorded in the exit log" "a code=2 row" "none"; fi

# The refusal says why, on stderr, naming the argument.
err="$(bash "$INST/scripts/channels.sh" --bogus 2>&1 >/dev/null)"
case "$err" in *"unknown argument(s) --bogus"*LAUNCHGATE1008*) pass "the refusal names the argument and the gate";;
  *) fail "the refusal names the argument and the gate" "unknown argument(s) --bogus ... LAUNCHGATE1008" "$err";; esac

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
