#!/bin/bash
# Contract tests for the channel-watchdog.sh --check-limit subcommand.
#
# Guards the quota-limit gate introduced to fix the failure class where a stale
# keepalive caused by plan quota exhaustion (agent pauses -> keepalive stops)
# was misread as a wedged session and triggered a useless respawn. The new
# gate detects the usage-limit banner in the pane and holds instead.
#
# Tested via the pure --check-limit subcommand (exit 0 = no limit,
# exit 1 = limit detected). No tmux, no dashboard, no live session needed.
#
# Run: bash scripts/__tests__/channel-watchdog-quota.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="${WATCHDOG_BIN:-$INSTALL_DIR/scripts/channel-watchdog.sh}"

# Helper: run --check-limit with stdin, return exit code
check_limit() { printf '%s' "$1" | bash "$WATCHDOG" --check-limit; echo $?; }

echo "channel-watchdog --check-limit tests"
echo "======================================"
echo ""

# ---------------------------------------------------------------------------
# 1. Canonical usage-limit banner variants -> exit 1 (limit detected)
# ---------------------------------------------------------------------------
echo "1. Canonical limit-banner variants"

GOT=$(check_limit "You hit your session limit · resets 5:50pm")
[ "$GOT" = "1" ] && pass "hit your session limit" || fail "hit your session limit (got $GOT)"

GOT=$(check_limit "You hit the usage limit for this session")
[ "$GOT" = "1" ] && pass "hit the usage limit" || fail "hit the usage limit (got $GOT)"

GOT=$(check_limit "usage limit reached -- please try again later")
[ "$GOT" = "1" ] && pass "usage limit reached" || fail "usage limit reached (got $GOT)"

GOT=$(check_limit "You reached your usage limit for today")
[ "$GOT" = "1" ] && pass "reached your usage limit" || fail "reached your usage limit (got $GOT)"

GOT=$(check_limit "5-hour limit reached. Your limit resets at 8pm.")
[ "$GOT" = "1" ] && pass "N-hour limit reached" || fail "N-hour limit reached (got $GOT)"

GOT=$(check_limit "limit will reset at 08:00 tomorrow")
[ "$GOT" = "1" ] && pass "limit will reset at" || fail "limit will reset at (got $GOT)"

GOT=$(check_limit "upgrade to increase your usage limit")
[ "$GOT" = "1" ] && pass "upgrade to increase" || fail "upgrade to increase (got $GOT)"

echo ""

# ---------------------------------------------------------------------------
# 2. Banner in last 15 lines of a realistic pane -> exit 1
# ---------------------------------------------------------------------------
echo "2. Banner in bottom region of realistic pane"

# Build a pane with 20 lines of normal output + the limit banner at the bottom
PANE_WITH_BANNER="$(printf 'Some output line\n%.0s' {1..20})You hit your session limit · resets 5:50pm"
GOT=$(check_limit "$PANE_WITH_BANNER")
[ "$GOT" = "1" ] && pass "banner in bottom 15 lines" || fail "banner in bottom 15 lines (got $GOT)"

echo ""

# ---------------------------------------------------------------------------
# 3. Scrollback false-positive prevention: banner >15 lines from bottom -> exit 0
# ---------------------------------------------------------------------------
echo "3. Scrollback false-positive prevention (banner >15 lines from bottom)"

# 16 lines after the banner -- banner is line 1, so 16 lines below the bottom cutoff
SUFFIX="$(printf 'normal output\n%.0s' {1..16})"
PANE_SCROLLBACK="You hit your session limit · resets 5:50pm
${SUFFIX}"
GOT=$(check_limit "$PANE_SCROLLBACK")
[ "$GOT" = "0" ] && pass "banner in scrollback does not trigger" || fail "banner in scrollback does not trigger (got $GOT)"

echo ""

# ---------------------------------------------------------------------------
# 4. Healthy pane variants -> exit 0
# ---------------------------------------------------------------------------
echo "4. Healthy pane -- no limit banner"

GOT=$(check_limit "")
[ "$GOT" = "0" ] && pass "empty pane" || fail "empty pane (got $GOT)"

GOT=$(check_limit "

")
[ "$GOT" = "0" ] && pass "whitespace-only pane" || fail "whitespace-only pane (got $GOT)"

GOT=$(check_limit "> bypass permissions on sensitive operations? No")
[ "$GOT" = "0" ] && pass "idle footer present" || fail "idle footer present (got $GOT)"

GOT=$(check_limit "Working... (42s · 12.3k tokens)")
[ "$GOT" = "0" ] && pass "busy pane (no limit)" || fail "busy pane (no limit) (got $GOT)"

GOT=$(check_limit "API Error: 429 -- rate limit exceeded, retry in 5s")
[ "$GOT" = "0" ] && pass "transient 429 rate-limit does not trigger" || fail "transient 429 rate-limit does not trigger (got $GOT)"

echo ""

# ---------------------------------------------------------------------------
# 5. Case-insensitivity
# ---------------------------------------------------------------------------
echo "5. Case-insensitivity"

GOT=$(check_limit "USAGE LIMIT REACHED")
[ "$GOT" = "1" ] && pass "USAGE LIMIT REACHED (uppercase)" || fail "USAGE LIMIT REACHED (got $GOT)"

GOT=$(check_limit "Usage Limit Reached")
[ "$GOT" = "1" ] && pass "Usage Limit Reached (mixed case)" || fail "Usage Limit Reached (got $GOT)"

echo ""
echo "--------------------------------------"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
