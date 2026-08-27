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
  # The monitor sources scripts/lib/send-telegram.sh, so a case dir without it
  # is not a smaller install -- it is a BROKEN one, and the difference would
  # only show up as a silently missing send. Copy what a real install has.
  mkdir -p "$c/scripts/lib"; cp "$INSTALL_DIR/scripts/lib/send-telegram.sh" "$c/scripts/lib/"
  printf 'MAIN_AGENT_ID=probe\nALLOWED_CHAT_ID=1\n' > "$c/.env"
  echo "$c"
}

# A case that can actually DELIVER: a bot token plus a curl stub standing in for
# the Bot API. Without this the dedupe assertions were passing for the wrong
# reason -- the old code stamped before sending, so "no token" still suppressed
# the second alert. Now the stamp depends on a real delivery, so the test has to
# provide one.
#   deliver_case <name> <ok|fail>
deliver_case() {
  local c; c="$(new_case "$1")"
  mkdir -p "$c/fakehome/.claude/channels/telegram" "$c/fakebin"
  printf 'TELEGRAM_BOT_TOKEN=123456:AAfake-token-for-tests\n' \
    > "$c/fakehome/.claude/channels/telegram/.env"
  if [ "$2" = "ok" ]; then
    printf '#!/bin/sh\nprintf %%s "{\\"ok\\":true,\\"result\\":{}}"\nexit 0\n' > "$c/fakebin/curl"
  else
    # An HTTP 200 carrying ok:false -- the exact shape that used to be invisible.
    printf '#!/bin/sh\nprintf %%s "{\\"ok\\":false,\\"error_code\\":400,\\"description\\":\\"Bad Request: chat not found\\"}"\nexit 0\n' > "$c/fakebin/curl"
  fi
  chmod +x "$c/fakebin/curl"
  echo "$c"
}
run_case() { (cd "$1" && HOME="$1/fakehome" PATH="$1/fakebin:$PATH" bash scripts/limit-monitor.sh >/dev/null 2>&1); }
# An alert was RAISED -- deliberately independent of whether it was delivered.
# The old form grepped only "ALERT wanted", the line for a case with no bot
# token, so the moment a case could actually deliver, the same true state read
# as "no alert". What these cases assert is that the monitor DECIDED to alert;
# whether the send succeeded is a separate question with its own cases below.
alerted() { grep -qE 'ALERT (wanted|sent|send FAILED)' "$1/store/limit-monitor.log" 2>/dev/null; }

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

C="$(deliver_case quota_hit ok)"
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
if alerted "$C"; then
  fail "94% -> 97% in the same window alerted twice"
else
  pass "94% -> 97% in the same window stays at one alert"
fi
# Running out completely is a new level, and must be said out loud.
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":100,"resets_at":%d}}}\n' "$now" "$reset" \
  > "$C/store/.claude-rate-limits.json"
: > "$C/store/limit-monitor.log"
run_case "$C"
if alerted "$C"; then
  pass "100% alerts even though 90% already did"
else
  fail "100% was swallowed by the 90% alert"
fi
# A new window (new resets_at) starts clean.
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":94,"resets_at":%d}}}\n' "$now" "$((reset + 18000))" \
  > "$C/store/.claude-rate-limits.json"
: > "$C/store/limit-monitor.log"
run_case "$C"
if alerted "$C"; then
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

# A window can roll over while the reading stays put: the numbers only move
# when a new API response brings them, so after the reset the same block sits
# there with resets_at in the past. Measured at the 22:00 rollover, 2026-08-18.
C="$(new_case quota_rolled_over)"
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":99,"resets_at":%d}}}\n' "$now" "$((now - 60))" \
  > "$C/store/.claude-rate-limits.json"
run_case "$C"
if alerted "$C"; then
  fail "alerted about a window that has already reset"
elif grep -q "already past their reset" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "a window past its reset is skipped, and says so"
else
  fail "the rolled-over window was skipped without a trace"
fi
# ...but a live window next to a rolled-over one must still get through.
C="$(new_case quota_mixed)"
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":99,"resets_at":%d},"seven_day":{"used_percentage":92,"resets_at":%d}}}\n' \
  "$now" "$((now - 60))" "$reset" > "$C/store/.claude-rate-limits.json"
run_case "$C"
if grep -q "quota:seven_day" "$C/store/limit-monitor.log" 2>/dev/null; then
  pass "the live weekly window still alerts beside a rolled-over one"
else
  fail "a rolled-over window silenced the live one next to it"
fi

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

echo "(d) a FAILED delivery must not suppress the retry"
# This is the case the whole honest-send contract exists for. The Bot API can
# answer HTTP 200 with {"ok":false} -- bad chat_id, blocked bot, mangled .env --
# and the old code could not tell that from a delivered alert: it stamped the
# dedupe key BEFORE sending and logged "ALERT sent" unconditionally. The result
# was the worst possible one: the alert nobody received, silenced forever by its
# own suppression stamp, on the one signal that cannot be reported any other way.
CF="$(deliver_case quota_fail fail)"
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":94,"resets_at":%d}}}\n' "$now" "$reset" \
  > "$CF/store/.claude-rate-limits.json"
run_case "$CF"
if grep -q "ALERT send FAILED" "$CF/store/limit-monitor.log" 2>/dev/null; then
  pass "an ok:false response is reported as a failure, not as a send"
else
  fail "an ok:false response was logged as a successful send"
fi
if [ -s "$CF/store/.limit-monitor-quota-state" ]; then
  fail "the dedupe stamp was written despite the delivery failing"
else
  pass "no dedupe stamp after a failed delivery"
fi
# ...and therefore the next tick must try again rather than call it old news.
: > "$CF/store/limit-monitor.log"
run_case "$CF"
if grep -q "quota signal unchanged" "$CF/store/limit-monitor.log" 2>/dev/null; then
  fail "the next tick suppressed an alert that was never delivered"
else
  pass "the next tick retries an undelivered alert"
fi

# The mirror case, so the pair above cannot pass for the wrong reason: with a
# delivering stub the stamp MUST appear. Without this, a bug that never stamps
# at all would look like a perfect result.
CO="$(deliver_case quota_ok_stamp ok)"
printf '{"written_at":%d,"rate_limits":{"five_hour":{"used_percentage":94,"resets_at":%d}}}\n' "$now" "$reset" \
  > "$CO/store/.claude-rate-limits.json"
run_case "$CO"
if [ -s "$CO/store/.limit-monitor-quota-state" ]; then
  pass "a delivered alert does write the dedupe stamp"
else
  fail "a delivered alert left no dedupe stamp -- alerts would repeat forever"
fi

echo ""
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$FAILED"
