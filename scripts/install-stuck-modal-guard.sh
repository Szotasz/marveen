#!/bin/bash
# install-stuck-modal-guard.sh
#
# Installs the launchd twin of scripts/systemd/stuck-modal-guard.timer (macOS).
# Without this unit scripts/stuck-modal-guard.sh never runs on macOS: the
# installer only ever shipped the systemd timer, so on a Mac nothing closes a
# modal that wedges the main channels session. Measured 2026-10-05 on the Mac
# mini (MODELCONFIRM1005): after a /model the CLI's "Switch model?" dialog held
# the main session for half an hour -- every inbound Telegram message queued
# behind it -- and no launchd job of any guard existed to notice. The dashboard's
# own pane classifier reads such a pane as 'unknown' and does not act on it.
#
# Period parity with the systemd timer:
#   OnUnitActiveSec=60s -> StartInterval 60
#   OnBootSec=150s      -> RunAtLoad true (launchd has no boot-delay knob for
#                          agents; an early first run is safe -- the guard only
#                          acts on a pane that stays stuck for STUCK_MODAL_SECONDS,
#                          i.e. at least two consecutive observations)
#   AccuracySec=10s     -> no launchd equivalent
#
# Installing it does NOT turn automatic recovery on (#1694 review, the
# maintainers' opt-in rule): the guard's default STUCK_MODAL_MODE is log -- it
# detects a stuck main pane and logs it once per episode. STUCK_MODAL_MODE=alert
# in .env adds one owner alert per episode; only STUCK_MODAL_MODE=act sends
# Escape and, if that fails, respawns (a working or idle pane is never touched,
# and the respawn shares channel-watchdog.sh's grace stamp).
#
# Usage:
#   scripts/install-stuck-modal-guard.sh            # install, do not start
#   scripts/install-stuck-modal-guard.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# #1873: com.<SERVICE_ID>.stuck-modal-guard, not a fixed com.marveen.stuck-modal-guard -- two installs
# under one user must not share (and overwrite) one helper job.
. "$SCRIPT_DIR/launchd-label.sh"

# PEERSESSION1025: optional --session <tmux-session> installs a SECOND, independent
# instance that watches a PEER agent's pane instead of the main channels session.
# Why this exists: the Claude Code autocompact dialog opens on peer panes too, and
# while it is open detectPaneState reads 'unknown' and every scheduled round for
# that agent is refused (measured 2026-10-25 on peet: 58,5 and 55 minutes of
# blocked delivery). One guard instance can only watch one session.
# Each instance needs its OWN state dir, or the episode stamps, the respawn
# counter and the report stamp would collide between sessions.
# The guard itself never respawns a peer pane (see PEERSESSION1025 there): the
# respawn command line belongs to the main agent.
LOAD=0
SESSION_ARG=""
PRINT_LABEL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --load) LOAD=1 ;;
    --print-label) PRINT_LABEL=1 ;;
    --session) shift; SESSION_ARG="${1:-}" ;;
    --session=*) SESSION_ARG="${1#--session=}" ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift || true
done
# Sanitize: the value becomes part of a launchd label and a path.
SESSION_SAFE="$(printf '%s' "$SESSION_ARG" | tr -cd 'a-zA-Z0-9_-')"
if [ -n "$SESSION_ARG" ] && [ -z "$SESSION_SAFE" ]; then
  echo "ERROR: --session value has no usable characters: $SESSION_ARG" >&2; exit 2
fi

LABEL="$(helper_launchd_label "$PROJECT_DIR" stuck-modal-guard)"
STATE_DIR="$PROJECT_DIR/store"
LOG_PATH="$PROJECT_DIR/store/stuck-modal-guard.log"
if [ -n "$SESSION_SAFE" ]; then
  LABEL="$LABEL-$SESSION_SAFE"
  STATE_DIR="$PROJECT_DIR/store/stuck-modal-$SESSION_SAFE"
  LOG_PATH="$PROJECT_DIR/store/stuck-modal-guard-$SESSION_SAFE.log"
fi
# update.sh asks the installer for the label instead of grepping a fixed one.
if [ "$PRINT_LABEL" = "1" ]; then printf '%s\n' "$LABEL"; exit 0; fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUARD="$PROJECT_DIR/scripts/stuck-modal-guard.sh"

if [ ! -f "$GUARD" ]; then
  echo "ERROR: $GUARD not found." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
# ISSUE1895 (#1895): the job's TZ is the install zone, written only when the
# operator pinned one (SCHEDULER_TZ); otherwise no TZ key, so the job follows the
# OS zone like the main dashboard/channels units. It used to be a hardcoded
# Europe/Budapest, so on any other install its log stamps ran off the dashboard's.
. "$SCRIPT_DIR/lib/install-tz.sh"
PINNED_TZ="$(install_tz_pinned "$PROJECT_DIR")"
TZ_XML=""
if [ -n "$PINNED_TZ" ]; then
  # Leading newline: it is appended to the line above, so an unpinned plist
  # has no blank line where the key would be.
  TZ_XML="
    <key>TZ</key>
    <string>$PINNED_TZ</string>"
fi

# Only the main instance inherits the legacy fixed label; a per-session instance
# is new, so there is nothing of its own to retire (and it must not touch the
# main instance's unit).
if [ -z "$SESSION_SAFE" ]; then
  retire_legacy_helper_label "$PROJECT_DIR" stuck-modal-guard "$LABEL" "$HOME/Library/LaunchAgents"
fi
mkdir -p "$STATE_DIR"
SESSION_XML=""
if [ -n "$SESSION_SAFE" ]; then
  SESSION_XML="
    <key>CHANNELS_SESSION</key>
    <string>$SESSION_ARG</string>
    <key>STUCK_MODAL_STATE_DIR</key>
    <string>$STATE_DIR</string>"
fi
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$GUARD</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$(id -un)</string>$TZ_XML$SESSION_XML
  </dict>
</dict>
</plist>
PLIST_EOF

echo "Wrote launchd unit: $PLIST"

if [ "$LOAD" = "1" ]; then
  # ISSUE1891 (#1891): registered AND run once, verified -- not a bare load.
  . "$SCRIPT_DIR/launchd-unit.sh"
  RUNS="$(start_launchd_periodic_unit "$PLIST" "$LABEL")"
  if [ -z "$RUNS" ]; then
    echo "NOT RUNNING: $LABEL is installed but did not run. launchd runs these jobs only inside a GUI login session (an install over SSH has none). From a terminal of the GUI login:" >&2
    print_periodic_unit_remedy "$PLIST" "$LABEL" >&2
    exit 3
  fi
  echo "Loaded $LABEL (every 60s + at load). Default STUCK_MODAL_MODE=log: it detects and logs a stuck main pane, nothing else. alert adds an owner alert; act enables Escape + respawn."
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
fi
