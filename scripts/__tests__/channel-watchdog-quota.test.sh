#!/bin/bash
# Contract tests for the channel-watchdog.sh quota-gate subcommands.
#
# Guards the quota-limit gate introduced to fix the failure class where a stale
# keepalive caused by plan quota exhaustion (agent pauses -> keepalive stops)
# was misread as a wedged session and triggered a useless respawn.
#
# Two subcommands under test:
#   --check-limit          pure stdin detector, no side effects
#   --check-limit-hold     stateful wrapper: manages a tick counter file so the
#                          quota hold is delayed (timed), not permanent
#
# Three sub-cases that require the capped hold (not covered by --check-limit alone):
#   [case 1] AUTHDEAD bypass: when AUTHDEAD=true the gate 3 block is skipped
#            entirely in main flow; --check-limit-hold exit codes let the caller
#            make that decision. Tested indirectly: exit 1 != 0, exit 2 != 0.
#   [case 2] "approaching usage limit" over-match: detection is correct but a
#            functional session would hold PERMANENTLY under the old design. The
#            capped hold bounds this: after QUOTA_HOLD_MAX_TICKS the gate falls
#            through so respawn/alert machinery can surface the stuck state.
#   [case 3] Agent own-message in scrollback: an agent message quoting a quota
#            banner lands in the bottom 15 lines. Detection fires; the cap
#            prevents silent permanent hold.
#
# No tmux, no dashboard, no live session needed.
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

# ---------------------------------------------------------------------------
# 6. --check-limit-hold: basic counter behaviour
# ---------------------------------------------------------------------------
echo "6. --check-limit-hold -- counter management"

# Helper: run --check-limit-hold with given pane content, count file, and max
# Returns the exit code as a string.
hold_tick() {
  local pane="$1" cf="$2" max="$3"
  printf '%s' "$pane" | bash "$WATCHDOG" --check-limit-hold "$cf" "$max"
  echo $?
}

CF="$(mktemp)"
MAX=3  # small cap for tests; main script uses QUOTA_HOLD_MAX_TICKS=12

# No banner: exit 0, counter file removed
rm -f "$CF"
GOT=$(hold_tick "" "$CF" "$MAX")
[ "$GOT" = "0" ] && pass "no banner -> exit 0" || fail "no banner -> exit 0 (got $GOT)"
[ ! -f "$CF" ] && pass "no banner -> count file removed" || fail "no banner -> count file removed (file exists, content=$(cat "$CF" 2>/dev/null))"

# First tick with banner: exit 1, counter = 1
GOT=$(hold_tick "You hit your session limit · resets 5:50pm" "$CF" "$MAX")
[ "$GOT" = "1" ] && pass "first banner tick -> exit 1 (hold)" || fail "first banner tick -> exit 1 (got $GOT)"
CNT=$(cat "$CF" 2>/dev/null || echo "MISSING")
[ "$CNT" = "1" ] && pass "first banner tick -> counter=1" || fail "first banner tick -> counter=1 (got $CNT)"

# Second tick: exit 1, counter = 2
GOT=$(hold_tick "You hit your session limit · resets 5:50pm" "$CF" "$MAX")
[ "$GOT" = "1" ] && pass "second banner tick -> exit 1 (hold)" || fail "second banner tick -> exit 1 (got $GOT)"
CNT=$(cat "$CF" 2>/dev/null || echo "MISSING")
[ "$CNT" = "2" ] && pass "second banner tick -> counter=2" || fail "second banner tick -> counter=2 (got $CNT)"

# Third tick (count reaches MAX): exit 2 (cap exceeded), counter file removed
GOT=$(hold_tick "You hit your session limit · resets 5:50pm" "$CF" "$MAX")
[ "$GOT" = "2" ] && pass "cap tick -> exit 2 (fall through)" || fail "cap tick -> exit 2 (got $GOT)"
[ ! -f "$CF" ] && pass "cap tick -> count file removed" || fail "cap tick -> count file removed (file exists)"

# After cap: next banner tick starts fresh from 1, not stuck at cap forever
GOT=$(hold_tick "You hit your session limit · resets 5:50pm" "$CF" "$MAX")
[ "$GOT" = "1" ] && pass "post-cap first tick -> exit 1 again" || fail "post-cap first tick -> exit 1 (got $GOT)"
CNT=$(cat "$CF" 2>/dev/null || echo "MISSING")
[ "$CNT" = "1" ] && pass "post-cap counter restarts at 1" || fail "post-cap counter restarts at 1 (got $CNT)"

# Banner clears mid-hold: counter reset
GOT=$(hold_tick "" "$CF" "$MAX")
[ "$GOT" = "0" ] && pass "banner clears mid-hold -> exit 0" || fail "banner clears mid-hold -> exit 0 (got $GOT)"
[ ! -f "$CF" ] && pass "banner clears mid-hold -> counter file removed" || fail "banner clears mid-hold -> counter reset (file still exists)"

rm -f "$CF"

echo ""

# ---------------------------------------------------------------------------
# 7. [case 2] "approaching usage limit" -- detection fires, hold is capped
# ---------------------------------------------------------------------------
echo "7. [case 2] approaching-banner is capped, not permanent"

CF="$(mktemp)"
MAX=2  # cap fires at count=MAX (i.e. after MAX-1 hold ticks + 1 cap tick)

# Detection fires (would trigger permanent hold under old design): count=1 < 2 -> hold
GOT=$(hold_tick "You are approaching your usage limit for this period" "$CF" "$MAX")
[ "$GOT" = "1" ] && pass "approaching banner -> exit 1 (detection correct)" || fail "approaching banner -> exit 1 (got $GOT)"

# At cap (count reaches MAX=2, not < MAX): falls through (exit 2), not held permanently
GOT=$(hold_tick "You are approaching your usage limit for this period" "$CF" "$MAX")
[ "$GOT" = "2" ] && pass "approaching banner at cap -> exit 2 (not permanent)" || fail "approaching banner at cap -> exit 2 (got $GOT)"

rm -f "$CF"

echo ""

# ---------------------------------------------------------------------------
# 8. [case 3] Agent own-message in scrollback: capped, not permanent
# ---------------------------------------------------------------------------
echo "8. [case 3] agent message about quota in pane -- capped hold, not silent permanent"

CF="$(mktemp)"
MAX=3  # 3 ticks total: tick 1 -> hold, tick 2 -> hold, tick 3 -> cap (fall through)

# Agent replied: "The Claude plan hit your session limit -- this resets at 6pm."
# This lands in the bottom 15 lines and fires detection.
AGENT_MSG="I looked into it. The Claude plan hit your session limit -- this resets at 6pm."
GOT=$(hold_tick "$AGENT_MSG" "$CF" "$MAX")
[ "$GOT" = "1" ] && pass "agent message tick 1 -> hold (detection expected)" || fail "agent message tick 1 -> hold (got $GOT)"

GOT=$(hold_tick "$AGENT_MSG" "$CF" "$MAX")
[ "$GOT" = "1" ] && pass "agent message tick 2 -> hold" || fail "agent message tick 2 -> hold (got $GOT)"

# At cap: falls through so respawn/alert machinery can fire -- NOT silent forever
GOT=$(hold_tick "$AGENT_MSG" "$CF" "$MAX")
[ "$GOT" = "2" ] && pass "agent message at cap -> exit 2 (not permanently silent)" || fail "agent message at cap -> exit 2 (got $GOT)"

rm -f "$CF"

echo ""
echo "--------------------------------------"
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
