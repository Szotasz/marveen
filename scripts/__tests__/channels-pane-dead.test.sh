#!/bin/bash
# Contract tests for the pane-dead detector in scripts/channels.sh (PANEDEAD919).
#
# Origin (2026-09-19, PR #1402 verify): `remain-on-exit on` keeps a pane whose
# claude died, so `while has-session` never ends and a dead main channel waits
# out the 180s plugin-dead grace (600-2400s on a cold-start crash) instead of
# the seconds the session-gone path used to take. The detector must:
#   - report dead on a positive pane_dead=1 (single or any pane),
#   - report alive on 0,
#   - report alive when tmux itself fails (fail-safe: no restart on a broken
#     instrument),
# and the suite must be able to go red: CHANNELS_BIN points it at a copy.
# Driven through `channels.sh --pane-dead-check <session>` with a fake tmux
# (CHANNELS_TMUX_BIN); nothing here touches a real tmux server.
# Run: bash scripts/__tests__/channels-pane-dead.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
FAKE="$TMPD/tmux"

# $1 = label, $2 = expected (dead|alive), $3 = fake tmux body
expect_check() {
  printf '#!/bin/sh\n%s\n' "$3" > "$FAKE"; chmod +x "$FAKE"
  local got
  got="$(CHANNELS_TMUX_BIN="$FAKE" bash "$CHANNELS" --pane-dead-check marveen-channels 2>/dev/null)"
  if [ "$got" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$got"; fi
}

echo "channels.sh pane-dead detector"
echo "=============================="
expect_check "single dead pane -> dead"                    dead  'echo 1'
expect_check "single live pane -> alive"                   alive 'echo 0'
expect_check "several panes, one dead -> dead"             dead  'printf "0\n1\n0\n"'
expect_check "several live panes -> alive"                 alive 'printf "0\n0\n"'
expect_check "tmux fails (exit 1, no output) -> alive"     alive 'exit 1'
expect_check "tmux prints garbage -> alive (no false restart)" alive 'echo "no server running"'
expect_check "tmux prints 10 (not exactly 1) -> alive"     alive 'echo 10'

# The seam must receive the session name it was asked about, not a hardcoded one.
printf '#!/bin/sh\ncase "$*" in *"-t marveen-channels "*) echo 1;; *) echo 0;; esac\n' > "$FAKE"; chmod +x "$FAKE"
got="$(CHANNELS_TMUX_BIN="$FAKE" bash "$CHANNELS" --pane-dead-check marveen-channels 2>/dev/null)"
if [ "$got" = "dead" ]; then pass "queries the requested session"; else fail "queries the requested session" dead "$got"; fi

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
