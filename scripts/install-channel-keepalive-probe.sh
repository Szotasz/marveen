#!/bin/bash
# install-channel-keepalive-probe.sh
#
# Installs the launchd twin of scripts/systemd/channel-keepalive-probe.timer
# (macOS). Without this unit the token-free IDLE-path keepalive producer
# (scripts/channel-keepalive-probe.sh, #640) never runs on macOS: the only
# thing advancing store/.channel-keepalive is organic inbound, so every quiet
# window >= the 18-min staleness threshold reads as a dead channel to every
# consumer of the file (channel-coordinator false-DOWN flapping, the dormant
# staleness watchdog's premise). Measured 2026-08-16 (COORDDRIFT816).
#
# Period parity with the systemd timer:
#   OnUnitActiveSec=3min  -> StartInterval 180
#   OnBootSec=90s         -> RunAtLoad true (launchd has no boot-delay knob for
#                            agents; an immediate first run is safe -- the probe
#                            is idempotent and fail-closed)
#   AccuracySec=20s       -> no launchd equivalent; launchd timers are already
#                            coarse-grained, nothing to carry
#
# The probe itself is fail-closed by design: it only touches the keepalive
# after proving from the process tree that a telegram poller descends from the
# channels session's pane. A dead native means NO touch ("watchdog owns
# recovery"), so this producer can never mask a real outage with a false
# heartbeat.
#
# Usage:
#   scripts/install-channel-keepalive-probe.sh            # install, do not start
#   scripts/install-channel-keepalive-probe.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# #1873: com.<SERVICE_ID>.channel-keepalive-probe, not a fixed com.marveen.channel-keepalive-probe -- two installs
# under one user must not share (and overwrite) one helper job.
. "$SCRIPT_DIR/launchd-label.sh"
LABEL="$(helper_launchd_label "$PROJECT_DIR" channel-keepalive-probe)"
# update.sh asks the installer for the label instead of grepping a fixed one.
if [ "${1:-}" = "--print-label" ]; then printf '%s\n' "$LABEL"; exit 0; fi
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROBE="$PROJECT_DIR/scripts/channel-keepalive-probe.sh"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

if [ ! -f "$PROBE" ]; then
  echo "ERROR: $PROBE not found." >&2
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
retire_legacy_helper_label "$PROJECT_DIR" channel-keepalive-probe "$LABEL" "$HOME/Library/LaunchAgents"
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
    <string>$PROBE</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>180</integer>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/store/channel-keepalive-probe.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/store/channel-keepalive-probe.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$(id -un)</string>$TZ_XML
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
  echo "Loaded $LABEL (every 180s + at load). It only ever TOUCHES store/.channel-keepalive after proving the telegram poller alive from the process tree -- a dead native is never masked."
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
fi
