#!/bin/bash
# #1878 item 3 -- the rapid-exit line in store/channels-failures.log names WHY the
# wait loop ended (a fixed reason category) and, for a dead pane, claude's exit
# status (digits only, never pane text). It must keep the "rapid-exit after"
# prefix that the backoff counter greps for.
#
# Like channels-rapid-exit-count.test.sh, the functions under test are LIFTED out
# of channels.sh (a copy here would pass while the script drifts), and tmux is a
# stub. Nothing touches a real session.
# Run: bash scripts/__tests__/channels-rapid-exit-reason.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

lift() { sed -n "/^$1() {\$/,/^}\$/p" "$SRC"; }
FNS="$(lift pane_dead_exit_status; lift rapid_exit_log_line)"
case "$FNS" in
  *pane_dead_exit_status*rapid_exit_log_line*) ;;
  *) echo "  FAIL: could not lift the two functions from $SRC (renamed? then this test is blind)"; echo "PASS: $PASS  FAIL: 1"; exit 1 ;;
esac
COUNT_LINE="$(grep -E '^\s*FAIL_COUNT=\$\(' "$SRC" | head -1)"

# tmux stub: prints $FAKE_PANE_STATUS for the #{pane_dead_status} query.
cat > "$TMP/tmux" <<'EOF'
#!/bin/bash
printf '%s\n' "${FAKE_PANE_STATUS:-}"
EOF
chmod +x "$TMP/tmux"

status_for() { FAKE_PANE_STATUS="$1" TMUX="$TMP/tmux" bash -c "$FNS"'
pane_dead_exit_status sess'; }
line_for() { bash -c "$FNS"'
rapid_exit_log_line "$1" "$2" "$3"' _ "$@"; }

echo "1. pane_dead_exit_status"
s="$(status_for 137)"; [ "$s" = "137" ] && pass "a numeric status is read" || fail "a numeric status is read" "137" "$s"
s="$(status_for 'oops 1')"; [ -z "$s" ] && pass "anything but digits is dropped (no pane text)" || fail "anything but digits is dropped" "''" "$s"
s="$(status_for '')"; [ -z "$s" ] && pass "no status -> empty" || fail "no status -> empty" "''" "$s"

echo "2. rapid_exit_log_line"
l="$(line_for 7 pane-dead 137)"
case "$l" in *" rapid-exit after 7s reason=pane-dead pane_status=137") pass "reason and status" ;; *) fail "reason and status" "... rapid-exit after 7s reason=pane-dead pane_status=137" "$l" ;; esac
l="$(line_for 12 plugin-never-started '')"
case "$l" in *" rapid-exit after 12s reason=plugin-never-started") pass "no status -> no pane_status field" ;; *) fail "no status -> no pane_status field" "... reason=plugin-never-started" "$l" ;; esac

echo "3. the backoff counter still counts the new line"
mkdir -p "$TMP/i/store"
{ line_for 3 session-gone ''; echo "WARN: something else"; line_for 4 pane-dead 1; } > "$TMP/i/store/channels-failures.log"
got="$(INSTALL_DIR="$TMP/i" bash -c "$COUNT_LINE"'; echo "$FAIL_COUNT"' 2>/dev/null | tail -1)"
[ "$got" = "2" ] && pass "two rapid-exit lines count as 2" || fail "two rapid-exit lines count as 2" "2" "$got"

echo "4. wiring in channels.sh"
if grep -qE '^\s*rapid_exit_log_line "\$ELAPSED" "\$EXIT_REASON" "\$PANE_EXIT_STATUS" >> "\$INSTALL_DIR/store/channels-failures.log"' "$SRC"; then
  pass "the rapid-exit append goes through rapid_exit_log_line with the reason"
else
  fail "the rapid-exit append goes through rapid_exit_log_line" "the call" "not found"
fi
# Every break in the wait loop records its reason (within the 3 lines before it).
unlabelled="$(awk '/^while \$TMUX has-session/{inloop=1} inloop && /^done$/{inloop=0}
  inloop { if ($0 ~ /^[[:space:]]*break[[:space:]]*$/ && !(p1 ~ /EXIT_REASON=/ || p2 ~ /EXIT_REASON=/ || p3 ~ /EXIT_REASON=/)) n++; p3=p2; p2=p1; p1=$0 }
  END { print n+0 }' "$SRC")"
breaks="$(awk '/^while \$TMUX has-session/{inloop=1} inloop && /^done$/{inloop=0} inloop && /^[[:space:]]*break[[:space:]]*$/{n++} END{print n+0}' "$SRC")"
[ "$breaks" -ge 3 ] && [ "$unlabelled" = "0" ] && pass "all $breaks breaks of the wait loop set EXIT_REASON" || fail "every break sets EXIT_REASON" "0 unlabelled of >=3" "$unlabelled of $breaks"
grep -qE '^EXIT_REASON="session-gone"$' "$SRC" && pass "the loop-condition exit defaults to session-gone" || fail "session-gone default" "EXIT_REASON=\"session-gone\"" "missing"

echo
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
