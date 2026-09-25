#!/bin/bash
# Token-free IDLE-path keepalive producer (systemd --user timer on Linux,
# launchd StartInterval on macOS via install-channel-keepalive-probe.sh --
# every 3 min, see scripts/systemd/channel-keepalive-probe.timer).
#
# WHY: the keepalive freshness signal (store/.channel-keepalive mtime) has two
# intended producers:
#   1. organic inbound  -- channel-monitor advances the mtime on every ingested
#      message (refreshKeepaliveFromInbound). Covers BUSY periods, token-free.
#   2. an IDLE-path keep-alive -- historically a scheduled Telegram MCP
#      edit_message round-trip run inside the channels TUI every ~6 min, which
#      touched the file REGARDLESS of traffic. That scheduled task went missing
#      (regression since #372), so during QUIET periods neither producer fires,
#      the file goes stale past channel-watchdog's 15-min threshold, and the
#      watchdog false-respawns a healthy-but-idle session every ~30 min. Each
#      needless respawn re-opens/wedges the /mcp menu -- the visible symptom.
#
# This script restores producer #2 WITHOUT a model round-trip (token-free): it
# proves the channel is genuinely alive from the PROCESS TREE and only then
# advances the keepalive. If the pipe is truly dead it does NOT touch, so the
# watchdog still legitimately respawns a real wedge.
#
# Liveness proof (all must hold): the ${id}-channels tmux session exists, its
# claude pid is alive, and a telegram plugin poller (bun|node under a
# /telegram/ plugin dir) descends from that claude. Ancestry is verified so a
# stray poller from another context cannot mask a dead main-session pipe.

set -u

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
KEEPALIVE_FILE="$STORE/.channel-keepalive"
LOG_TAG="channel-keepalive-probe"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*"; }

# SELF-TIMEOUT (KEEPALIVEHANG923). launchd never starts a second instance of
# a StartInterval job while one is still running, so ONE hung run (a blocked
# tmux/ps call) silently stops every later run. Measured 2026-09-23: launchd's
# run counter was ~240 runs (~12 h) short of the 180 s cadence since the plist
# was loaded, the keepalive went stale from ~01:34 with a LIVE poller and no
# probe log line, and the dashboard respawned a healthy main session 28 times
# (02:19-13:32). A run takes well under a second; kill it long before the next
# interval so a hang costs one tick, not a night.
PROBE_TIMEOUT_S="${PROBE_TIMEOUT_S:-60}"
( sleep "$PROBE_TIMEOUT_S"
  log "WARN probe run exceeded ${PROBE_TIMEOUT_S}s -- killing it so launchd can start the next one (KEEPALIVEHANG923)"
  kill -TERM $$ 2>/dev/null ) 2>/dev/null &
PROBE_WATCHDOG_PID=$!
# disown + the subshell stderr redirect: no "Terminated: 15" job notice in the
# log on every normal run (the WARN above goes to stdout, so it still lands).
disown "$PROBE_WATCHDOG_PID" 2>/dev/null
# On a normal exit, stop the watchdog AND its sleep child.
trap 'pkill -P "$PROBE_WATCHDOG_PID" 2>/dev/null; kill "$PROBE_WATCHDOG_PID" 2>/dev/null' EXIT

# Whether a dedicated channel-watchdog recovery owner is actually installed on
# THIS host. The probe declines to recover a dead pipe on purpose -- but only a
# real, installed watchdog legitimately "owns recovery". The systemd
# channel-watchdog timer has NO launchd twin, so on macOS it is simply absent
# (CHANWDOG818): claiming an owner that isn't there turns a genuine outage into
# silence. Fail loud instead when nothing owns recovery.
channel_watchdog_installed() {
  if [ "$(uname -s)" = "Darwin" ]; then
    launchctl list 2>/dev/null | grep -q 'com\.marveen\.channel-watchdog'
  else
    # The systemd units on a renamed install are agent-prefixed
    # (<agent>-channel-watchdog.timer, the way <agent>-channels.service is);
    # only a stock install has the bare name. Checking the bare name alone
    # reported "no recovery unit installed" on every renamed host that HAD one.
    systemctl --user is-enabled "${MAIN_AGENT_ID}-channel-watchdog.timer" >/dev/null 2>&1 ||
      systemctl --user is-enabled channel-watchdog.timer >/dev/null 2>&1
  fi
}

# --- resolve the channels session (launch-order / rename independent) ---
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

# --- resolve the channel provider (this probe is NOT telegram-only) ---
# The poller match below greps the plugin dir out of the process argv, and that
# dir is named after the PROVIDER. Hardcoding /telegram/ made the probe a
# permanent no-op on every non-telegram install: it never found a poller, so it
# never advanced store/.channel-keepalive, so the only producer left was organic
# inbound. Measured on this discord install 2026-09-25 -- every probe tick since
# the channel was set up logged "no live telegram poller", and the keepalive was
# as stale as the last message the owner happened to send. That is also why the
# channel-watchdog timer must NOT be installed before this is fixed: its STALE
# arm would read a quiet-but-healthy session as dead and respawn it every 15
# minutes. Derived exactly as scripts/channel-watchdog.sh derives it.
CHANNEL_PROVIDER="$(grep -E '^CHANNEL_PROVIDER=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
CHANNEL_PROVIDER="${CHANNEL_PROVIDER:-telegram}"
CHANNEL_PROVIDER="${CHANNEL_PROVIDER//[^a-zA-Z0-9_-]/}"

TMUX_BIN="$(command -v tmux)"
if [ -z "$TMUX_BIN" ]; then
  log "tmux not on PATH; cannot probe. PATH=$PATH"
  exit 0
fi

# --- gate 1: the channels session must exist ---
if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  log "session $SESSION absent -- ${MAIN_AGENT_ID}-channels.service owns start; no touch"
  exit 0
fi

# --- gate 2: resolve the claude pid under the session's pane ---
pane_pid="$("$TMUX_BIN" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
if [ -z "$pane_pid" ]; then
  log "no pane pid for $SESSION -- no touch"
  exit 0
fi

# --- gate 3: a telegram poller must be alive AND descend from the pane pid ---
# ppid_of <pid> -> parent pid (empty if gone). Walk a candidate poller's
# ancestry up to init; require pane_pid on the chain so we only credit a poller
# that belongs to THIS session (closes the cross-context masking gap).
ppid_of() { ps -o ppid= -p "$1" 2>/dev/null | tr -d ' '; }

descends_from_pane() {
  local pid="$1" hops=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$hops" -lt 20 ]; do
    [ "$pid" = "$pane_pid" ] && return 0
    pid="$(ppid_of "$pid")"
    hops=$(( hops + 1 ))
  done
  return 1
}

alive=0
# Candidate pollers: bun/node processes whose argv references the provider's
# plugin dir (/discord/, /telegram/, ...).
#
# RUNTIME_TOKEN_RX below is the portable ERE spelling of the TS side's
# /\b(bun|node)\b/ (src/channel-coordinator/provider-poller-match.ts). It must
# stay equivalent to it: two detectors that disagree about the same process is
# the defect GH #1147 reported, not a detail. The previous pattern here was
# '(^| )(bun|node)( |$|.*/)', which required a SPACE or line start before the
# runtime token, so a poller launched from a full path -- the shape the official
# bun installer produces, /home/USER/.bun/bin/bun -- never matched, the probe
# reported "no live <provider> poller", and the keepalive was never advanced. With
# the 45 minute liveness ceiling that turns a quiet-but-healthy session into a
# fresh respawn every 15 minutes: the reporter measured 41 of them in one night,
# each losing the main agent's conversation.
#
# \b is NOT used here on purpose: BSD grep (macOS) does not support it reliably,
# and this probe runs on both. The character-class form is the portable
# equivalent.
RUNTIME_TOKEN_RX='(^|[^A-Za-z0-9_])(bun|node)([^A-Za-z0-9_]|$)'
while read -r cand; do
  [ -z "$cand" ] && continue
  if descends_from_pane "$cand"; then
    alive=1
    break
  fi
done < <(ps -axo pid,command 2>/dev/null | grep -E "$RUNTIME_TOKEN_RX" | grep -F "/${CHANNEL_PROVIDER}/" | grep -v grep | awk '{print $1}')

if [ "$alive" -ne 1 ]; then
  # Do NOT advance the keepalive: a dead pipe must stay visibly stale so a real
  # recovery owner can act. But only claim an owner that actually exists here.
  if channel_watchdog_installed; then
    log "no live $CHANNEL_PROVIDER poller under $SESSION (pane $pane_pid) -- pipe may be down; not touching (channel-watchdog owns recovery)"
  else
    log "WARN no live $CHANNEL_PROVIDER poller under $SESSION (pane $pane_pid) -- pipe may be down AND no channel-watchdog recovery unit is installed on this host (CHANWDOG818); automatic recovery relies only on process-death KeepAlive + the dashboard channel-monitor, so a FROZEN session while the dashboard is also down is NOT auto-recovered"
  fi
  exit 0
fi

# --- healthy: advance the keepalive freshness signal (token-free) ---
if [ -f "$KEEPALIVE_FILE" ]; then
  touch "$KEEPALIVE_FILE"
else
  date +%s > "$KEEPALIVE_FILE"
fi
exit 0
