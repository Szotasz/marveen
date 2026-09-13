#!/bin/bash
# Out-of-band channel outage alarm (CHANALARM912).
#
# WHY THIS EXISTS. On 2026-09-12 the main agent was silent on Telegram from
# 05:03 to 13:26 (8h23m). Every layer that was supposed to notice DID notice:
# channel-keepalive-probe.sh logged 139 consecutive WARN lines, one every three
# minutes, naming the exact fault. Nothing read that log. The owner found out by
# asking "do you get what I write?". A host reboot at 12:50 did not help, because
# the root cause (channels.sh parking its own live .env, ENVPARK912) re-fired on
# every start.
#
# The gap was never DETECTION. It was that detection had no way OUT of the box:
# the only path to the owner was the very channel that was down.
#
# So this unit deliberately shares nothing with the thing it watches:
#   - it does not need the dashboard (which can be down),
#   - it does not need the claude session (which can be wedged),
#   - it does not need the telegram PLUGIN (which is what fails),
#   - it talks to api.telegram.org with curl and a bot token, nothing else.
#
# SIGNAL. store/.channel-keepalive is touched by channel-keepalive-probe.sh ONLY
# when a live telegram poller is confirmed under the channels pane. Its mtime is
# therefore an already-proven liveness signal produced by a component that is
# already running. We consume it rather than re-implementing the poller check:
# two detectors that can disagree about the same fact is a defect, not a detail
# (see the RUNTIME_TOKEN_RX note in channel-keepalive-probe.sh). A consequence
# worth stating: if the probe itself dies, this file goes stale and we alarm.
# That is correct. A blind monitor is an outage.
#
# TOKEN SOURCES. The failure that motivated this script DESTROYED the live .env
# (it was moved aside to .env.legacy-<epoch>). An alarm that reads only the live
# .env would therefore have been mute in exactly the incident it exists for. We
# fall back to the newest parked copy, then to a dedicated read-only stash.
#
# ESCALATION (thresholds in seconds, probe cadence is ~180s):
#   >= RESTART_AFTER : try one service restart per outage, then keep watching.
#   >= ALARM_AFTER   : message the owner directly, regardless of whether the
#                      restart helped. Today's root cause survived a restart AND
#                      a reboot, so recovery must never gate the alarm.
#   every REALARM_EVERY while still down: one reminder, so a long outage does
#                      not decay into the same silence.
#   on recovery      : one all-clear, but only if we had alarmed.

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
CHAN_DIR="$INSTALL_DIR/.claude/channels/telegram"
KEEPALIVE_FILE="$STORE/.channel-keepalive"
STATE_FILE="$STORE/.channel-outage-alarm-state"
TOKEN_STASH="$STORE/.telegram-alarm-token"
BOOT_MARKER="$STORE/.channel-boot-notified"
LOG_FILE="$STORE/channel-outage-alarm.log"

BOOT_REPORT_AFTER=$(( 3 * 60 ))  # let the fleet finish coming up before reporting

STALE_AFTER=$(( 9 * 60 ))        # keepalive older than this => outage
RESTART_AFTER=$(( 9 * 60 ))      # first (and only) automatic restart attempt
ALARM_AFTER=$(( 15 * 60 ))       # tell the owner, restart or no restart
REALARM_EVERY=$(( 30 * 60 ))     # reminder cadence while still down

log() { printf '%s [channel-outage-alarm] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"; }

# Portable mtime. channel-watchdog.sh hard-codes `stat -c %Y`, which is GNU
# only: on macOS it exits non-zero and the caller's `|| echo 0` turns a FRESH
# file into an infinitely stale one. Measured 2026-09-12 -- that single flag is
# why installing that watchdog here would have respawned the channels pane every
# five minutes instead of protecting it. Never spell mtime one way.
mtime_of() {
  local f="$1" m=""
  m="$(stat -f %m "$f" 2>/dev/null)" || m=""
  [ -n "$m" ] || m="$(stat -c %Y "$f" 2>/dev/null)" || m=""
  [ -n "$m" ] || m=0
  printf '%s\n' "$m"
}

read_token() {
  local f tok=""
  for f in "$CHAN_DIR/.env" $(ls -t "$CHAN_DIR"/.env.legacy-* 2>/dev/null) "$TOKEN_STASH"; do
    [ -f "$f" ] || continue
    tok="$(sed -n 's/^[[:space:]]*TELEGRAM_BOT_TOKEN=//p' "$f" 2>/dev/null | head -1 | tr -d '"'"'"' \r')"
    if [ -n "$tok" ]; then printf '%s\n' "$tok"; return 0; fi
  done
  return 1
}

read_chat_id() {
  [ -f "$CHAN_DIR/access.json" ] || return 1
  python3 - "$CHAN_DIR/access.json" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    raise SystemExit(1)
a = d.get("allowFrom") or []
if not a:
    raise SystemExit(1)
print(a[0])
PY
}

# Direct Bot API send. No plugin, no session, no dashboard in the path.
send_alarm() {
  local text="$1" tok chat http
  tok="$(read_token)" || { log "ERROR cannot send: no bot token in $CHAN_DIR/.env, parked copies, or $TOKEN_STASH"; return 1; }
  chat="$(read_chat_id)" || { log "ERROR cannot send: no allowFrom chat id in $CHAN_DIR/access.json"; return 1; }
  http="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=${text}" 2>/dev/null)"
  if [ "$http" = "200" ]; then
    log "alarm delivered (HTTP 200)"
    return 0
  fi
  log "ERROR alarm send failed (HTTP ${http:-000})"
  return 1
}

restart_channels() {
  if command -v launchctl >/dev/null 2>&1; then
    if launchctl kickstart -k "gui/$(id -u)/com.nova.channels" >/dev/null 2>&1; then
      log "restart issued: launchctl kickstart -k gui/$(id -u)/com.nova.channels"
      return 0
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user restart marveen-channels.service >/dev/null 2>&1; then
      log "restart issued: systemctl --user restart marveen-channels.service"
      return 0
    fi
  fi
  log "ERROR no service manager could restart the channels unit"
  return 1
}

# --- state: outage_started restart_done last_alarm ---
outage_started=0; restart_done=0; last_alarm=0
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE" 2>/dev/null || true
fi
save_state() {
  printf 'outage_started=%s\nrestart_done=%s\nlast_alarm=%s\n' \
    "$outage_started" "$restart_done" "$last_alarm" > "$STATE_FILE"
}

now="$(date +%s)"

# Keep a token stash fresh whenever the live .env is intact, so a later run can
# still reach the owner after the live file is destroyed.
if [ -f "$CHAN_DIR/.env" ] && grep -q '^[[:space:]]*TELEGRAM_BOT_TOKEN=' "$CHAN_DIR/.env" 2>/dev/null; then
  if ! cmp -s "$CHAN_DIR/.env" "$TOKEN_STASH" 2>/dev/null; then
    ( umask 077; cp "$CHAN_DIR/.env" "$TOKEN_STASH.tmp.$$" && mv "$TOKEN_STASH.tmp.$$" "$TOKEN_STASH" ) 2>/dev/null \
      && log "token stash refreshed"
  fi
fi

# --- once per boot: tell the owner the machine came back and what state it is in ---
#
# WHY. A host restart is the one outage this alarm cannot report while it is
# happening: nothing on the box is running to send anything. The owner's only
# signal is silence, which is indistinguishable from a quiet day. 2026-09-12 had
# TWO restarts (11:23 unclean, 12:50 clean) and the owner learned of neither.
# One line per boot is proportionate: reboots are rare, and the message carries
# the health verdict, so "it came back" and "it came back BROKEN" look different.
#
# The `sec = <n>, usec = <m>` output needs an anchored match: a greedy `.*sec = `
# lands on usec and yields a boot time in 1970.
# sysctl lives in /usr/sbin, which is NOT on every PATH this script can inherit
# (measured: absent from the agent shell's PATH, present in the launchd unit's).
# Probing only `command -v sysctl` therefore silently disabled this whole block
# in half the environments -- and a disabled reporter looks exactly like a boot
# that never happened. Name the absolute paths.
boot_epoch=""
if [ -r /proc/stat ]; then
  boot_epoch="$(awk '/^btime /{print $2; exit}' /proc/stat 2>/dev/null)"
else
  for _sysctl in /usr/sbin/sysctl /sbin/sysctl "$(command -v sysctl 2>/dev/null)"; do
    [ -n "$_sysctl" ] && [ -x "$_sysctl" ] || continue
    boot_epoch="$("$_sysctl" -n kern.boottime 2>/dev/null | sed -n 's/^[^0-9]*sec *= *\([0-9][0-9]*\).*/\1/p')"
    [ -n "$boot_epoch" ] && break
  done
  unset _sysctl
fi
if [ -n "$boot_epoch" ] && [ "$boot_epoch" -gt 0 ] 2>/dev/null; then
  uptime_s=$(( now - boot_epoch ))
  seen_boot="$(cat "$BOOT_MARKER" 2>/dev/null || echo '')"
  if [ "$seen_boot" != "$boot_epoch" ] && [ "$uptime_s" -ge "$BOOT_REPORT_AFTER" ]; then
    ka_now=0; [ -f "$KEEPALIVE_FILE" ] && ka_now="$(mtime_of "$KEEPALIVE_FILE")"
    if [ "$ka_now" -gt 0 ] && [ $(( now - ka_now )) -lt "$STALE_AFTER" ]; then
      verdict="a Telegram-csatorna el"
    else
      verdict="a Telegram-csatorna NEM el -- nezd meg a gepet"
    fi
    if send_alarm "A gep ujraindult ($(date -r "$boot_epoch" '+%H:%M' 2>/dev/null || echo '?')), ujra futok. Allapot: ${verdict}."; then
      printf '%s\n' "$boot_epoch" > "$BOOT_MARKER"
      log "boot report sent (boot_epoch=$boot_epoch, $verdict)"
    else
      log "boot report NOT sent (send failed) -- will retry next tick"
    fi
  elif [ "$seen_boot" != "$boot_epoch" ]; then
    log "boot ${boot_epoch} not reported yet (uptime ${uptime_s}s < ${BOOT_REPORT_AFTER}s)"
  fi
fi

if [ ! -f "$KEEPALIVE_FILE" ]; then
  log "no keepalive file yet ($KEEPALIVE_FILE) -- probe not established, staying silent"
  exit 0
fi

ka="$(mtime_of "$KEEPALIVE_FILE")"
age=$(( now - ka ))

if [ "$age" -lt "$STALE_AFTER" ]; then
  if [ "$outage_started" != "0" ]; then
    down_for=$(( now - outage_started ))
    if [ "$last_alarm" != "0" ]; then
      send_alarm "A Telegram-csatorna ujra el. Kimaradas: $(( down_for / 60 )) perc." || true
    fi
    log "recovered after ${down_for}s (alarmed=$([ "$last_alarm" != 0 ] && echo yes || echo no))"
    outage_started=0; restart_done=0; last_alarm=0; save_state
  fi
  exit 0
fi

# --- we are in an outage ---
[ "$outage_started" = "0" ] && { outage_started="$now"; log "outage opened (keepalive ${age}s stale)"; }
down_for=$(( now - outage_started ))

if [ "$restart_done" = "0" ] && [ "$age" -ge "$RESTART_AFTER" ]; then
  restart_channels && restart_done="$now" || restart_done="failed-$now"
fi

if [ "$age" -ge "$ALARM_AFTER" ]; then
  if [ "$last_alarm" = "0" ] || [ $(( now - last_alarm )) -ge "$REALARM_EVERY" ]; then
    if send_alarm "A Telegram-csatorna $(( age / 60 )) perce nem el. Automatikus ujrainditas: $([ "$restart_done" = "0" ] && echo "nem tortent" || echo "megtortent, nem segitett"). A gepen a naplo: store/channel-outage-alarm.log"; then
      last_alarm="$now"
    fi
  fi
fi

save_state
exit 0
