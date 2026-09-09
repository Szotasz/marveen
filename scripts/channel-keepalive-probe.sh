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
    systemctl --user is-enabled channel-watchdog.timer >/dev/null 2>&1
  fi
}

# --- resolve the channels session (launch-order / rename independent) ---
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

TMUX_BIN="$(command -v tmux)"
if [ -z "$TMUX_BIN" ]; then
  log "tmux not on PATH; cannot probe. PATH=$PATH"
  exit 0
fi

# --- gate 1: the channels session must exist ---
if ! "$TMUX_BIN" has-session -t "$SESSION" 2>/dev/null; then
  log "session $SESSION absent -- marveen-channels.service owns start; no touch"
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
# Candidate pollers: bun/node processes whose argv references a /telegram/
# plugin dir.
#
# RUNTIME_TOKEN_RX below is the portable ERE spelling of the TS side's
# /\b(bun|node)\b/ (src/channel-coordinator/provider-poller-match.ts). It must
# stay equivalent to it: two detectors that disagree about the same process is
# the defect GH #1147 reported, not a detail. The previous pattern here was
# '(^| )(bun|node)( |$|.*/)', which required a SPACE or line start before the
# runtime token, so a poller launched from a full path -- the shape the official
# bun installer produces, /home/USER/.bun/bin/bun -- never matched, the probe
# reported "no live telegram poller", and the keepalive was never advanced. With
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
done < <(ps -axo pid,command 2>/dev/null | grep -E "$RUNTIME_TOKEN_RX" | grep -E '/telegram/' | grep -v grep | awk '{print $1}')

if [ "$alive" -ne 1 ]; then
  # Do NOT advance the keepalive: a dead pipe must stay visibly stale so a real
  # recovery owner can act. But only claim an owner that actually exists here.
  if channel_watchdog_installed; then
    log "no live telegram poller under $SESSION (pane $pane_pid) -- pipe may be down; not touching (channel-watchdog owns recovery)"
  else
    log "WARN no live telegram poller under $SESSION (pane $pane_pid) -- pipe may be down AND no channel-watchdog recovery unit is installed on this host (CHANWDOG818); automatic recovery relies only on process-death KeepAlive + the dashboard channel-monitor, so a FROZEN session while the dashboard is also down is NOT auto-recovered"
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
