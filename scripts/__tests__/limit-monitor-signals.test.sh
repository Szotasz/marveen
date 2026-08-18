#!/bin/bash
# What limit-monitor.sh must catch -- and what it must stay quiet about.
#
# The monitor is the only thing that can report an exhausted Claude quota: the
# agent cannot, it is the one out of tokens. So a MISS here is silent, and that
# is the failure this file exists to prevent. Every case runs the real script in
# an isolated install dir, with HOME pointed at an empty directory so no bot
# token is found and the alert is logged instead of sent to the owner.
set -u
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="$(mktemp -d)"
trap 'rm -rf "$BASE"' EXIT
FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

# Own tmux server (empty): otherwise the case would capture the real fleet's
# panes and every result would depend on what happens to be on screen.
export TMUX_TMPDIR="$BASE/tmux"; mkdir -p "$TMUX_TMPDIR"

new_case() {
  local c="$BASE/$1"; mkdir -p "$c/scripts" "$c/store" "$c/fakehome"
  cp "$INSTALL_DIR/scripts/limit-monitor.sh" "$c/scripts/"
  printf 'MAIN_AGENT_ID=probe\nALLOWED_CHAT_ID=1\n' > "$c/.env"
  echo "$c"
}
run_case() { (cd "$1" && HOME="$1/fakehome" bash scripts/limit-monitor.sh >/dev/null 2>&1); }
alerted() { grep -q "ALERT wanted" "$1/store/limit-monitor.log" 2>/dev/null; }

echo "(a) text signals that MUST alert"
i=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  i=$((i+1)); C="$(new_case "pos$i")"
  printf '%s\n' "$line" > "$C/store/channels.log"
  run_case "$C"
  if alerted "$C"; then pass "$line"; else fail "missed: $line"; fi
done <<'LINES'
Claude usage limit reached. Your limit will reset at 10pm.
5-hour limit reached, resets 11pm
You've reached your weekly limit for Opus.
Approaching your usage limit
Approaching Opus weekly limit, 5% left
Session limit reached, resets at 2am
API Error: 429 Too Many Requests
rate_limit_error
Out of credits
LINES

echo "(b) noise that must stay quiet"
i=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  i=$((i+1)); C="$(new_case "neg$i")"
  printf '%s\n' "$line" > "$C/store/channels.log"
  run_case "$C"
  if alerted "$C"; then fail "false alarm: $line"; else pass "$line"; fi
done <<'LINES'
2026-08-18 20:00:00 [heartbeat] all agents healthy
API Error: 529 Overloaded. This is a server-side issue, usually temporary
Mailjet free tier: 200 email/nap limit
limit-monitor: signal unchanged, already alerted
LINES

echo "(c) the measured path: rate_limits from the status line"
now=$(date +%s); reset=$((now + 3600))

C="$(new_case quota_hit)"
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":94,"resets_at":%d}}}\n' "$now" "$reset" \
  > "$C/store/.claude-rate-limits.json"
run_case "$C"
if grep -q "quota:five_hour" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "94% of the 5-hour window alerts"
else
  fail "94% of the 5-hour window did not alert"
fi
# Same window twice must not alert twice; the dedupe key carries resets_at, so
# the NEXT window (new reset time) is free to alert again.
: > "$C/store/limit-monitor.log"
run_case "$C"
if grep -q "quota signal unchanged" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "the same window is not re-alerted"
else
  fail "the same window alerted twice"
fi
# Creeping up inside the SAME window must stay quiet: keying on the raw
# percentage would mean a fresh alert for every point between 90 and 100.
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":97,"resets_at":%d}}}\n' "$now" "$reset" \
  > "$C/store/.claude-rate-limits.json"
: > "$C/store/limit-monitor.log"
run_case "$C"
if grep -q "ALERT wanted" "$C/store/limit-monitor.log" 2>/dev/null; then
  fail "94% -> 97% in the same window alerted twice"
else
  pass "94% -> 97% in the same window stays at one alert"
fi
# Running out completely is a new level, and must be said out loud.
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":100,"resets_at":%d}}}\n' "$now" "$reset" \
  > "$C/store/.claude-rate-limits.json"
: > "$C/store/limit-monitor.log"
run_case "$C"
if grep -q "ALERT wanted" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "100% alerts even though 90% already did"
else
  fail "100% was swallowed by the 90% alert"
fi
# A new window (new resets_at) starts clean.
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":94,"resets_at":%d}}}\n' "$now" "$((reset + 18000))" \
  > "$C/store/.claude-rate-limits.json"
: > "$C/store/limit-monitor.log"
run_case "$C"
if grep -q "ALERT wanted" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "the next window alerts again"
else
  fail "the next window stayed silent"
fi

C="$(new_case quota_weekly)"
printf '{"written_at":%d,"rate_limits":{"seven_day":{"used_percentage":91,"resets_at":%d}}}\n' "$now" "$reset" \
  > "$C/store/.claude-rate-limits.json"
run_case "$C"
if grep -q "quota:seven_day" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "91% of the weekly window alerts"
else
  fail "91% of the weekly window did not alert"
fi

C="$(new_case quota_low)"
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":40,"resets_at":%d},"seven_day":{"used_percentage":12,"resets_at":%d}}}\n' "$now" "$reset" "$reset" \
  > "$C/store/.claude-rate-limits.json"
run_case "$C"
if alerted "$C"; then fail "alerted below the threshold"; else pass "40% / 12% stays quiet"; fi

C="$(new_case quota_stale)"
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":99,"resets_at":%d}}}\n' "$((now - 90000))" "$((now - 80000))" \
  > "$C/store/.claude-rate-limits.json"
run_case "$C"
if alerted "$C"; then
  fail "alerted on a day-old reading"
elif grep -q "quota file stale" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "a stale reading is skipped, and says so"
else
  fail "a stale reading was skipped without a trace"
fi

echo ""
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$FAILED"
