#!/bin/bash
# install-channel-process-gate.sh
#
# Schedules scripts/hooks/channel-process-gate.py, which until now NOTHING ran.
#
# WHY (measured 2026-09-23): the gate was written with 16 tests and its own
# --notify path, and a grep for callers across the tree found none outside its
# own test suite. It detects the single failure a channel cannot report on
# itself: a session still DECLARES a channel plugin (`--channels plugin:...`)
# while the plugin's worker process is gone, so every inbound message is
# dropped and no reply can go out. On this install that state was reached
# repeatedly (2026-09-05, 09-06, 09-13, 09-15), and each time the owner learned
# about it by noticing the silence himself.
#
# The alarm travels on scripts/notify.sh (bot token + owner chat from the
# install .env), NOT through the plugin -- the plugin is the thing that died.
# The gate fires on TRANSITION, so a healthy host stays quiet, and a failed
# send is retried on the next tick instead of being assumed heard.
#
# Period: 5 minutes. The gate is a process-tree read (no network), so the cost
# is negligible, and 5 minutes is the same cadence the coarse channel-watchdog
# already runs at.
#
# Usage:
#   scripts/install-channel-process-gate.sh            # install, do not start
#   scripts/install-channel-process-gate.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
GATE="$PROJECT_DIR/scripts/hooks/channel-process-gate.py"
LOG="$PROJECT_DIR/store/channel-process-gate.log"

# SERVICE_ID keeps the unit name in step with every other unit this install
# writes (a branded install must not collide with a default one).
# `|| true` is load-bearing: under `set -euo pipefail` a grep that matches
# nothing (no .env yet -- exactly the state a FIRST install is in) fails the
# whole pipeline and kills the script before it writes anything. Measured by
# this script's own test on a temp HOME with no .env: exit 2, no unit written,
# no message. A monitor installer that dies silently on a fresh install is the
# same class of defect as the unscheduled gate it exists to fix.
SERVICE_ID="$(grep -E '^SERVICE_ID=' "$PROJECT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
if [ -z "$SERVICE_ID" ]; then
  SERVICE_ID="$(grep -E '^MAIN_AGENT_ID=' "$PROJECT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
fi
SERVICE_ID="${SERVICE_ID:-marveen}"
SERVICE_ID="${SERVICE_ID//[^a-zA-Z0-9_-]/}"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

if [ ! -f "$GATE" ]; then
  echo "ERROR: $GATE not found." >&2
  exit 1
fi

if [ "$(uname -s)" = "Darwin" ]; then
  LABEL="com.${SERVICE_ID}.channel-process-gate"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  PYTHON="$(command -v python3 || echo /usr/bin/python3)"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$GATE</string>
    <string>--notify</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$(id -un)</string>
    <key>CLAUDE_PROJECT_DIR</key>
    <string>$PROJECT_DIR</string>
  </dict>
</dict>
</plist>
PLIST_EOF
  echo "Wrote launchd unit: $PLIST"
  if [ "$LOAD" = "1" ]; then
    # `launchctl load` only PENDS the RunAtLoad spawn on modern macOS (measured
    # on 26.5.1): it returns 0 while the unit never runs. The shared helper
    # bootstraps, kickstarts and VERIFIES, so a unit that did not come up is
    # reported as such instead of being announced as started.
    # shellcheck source=/dev/null
    . "$PROJECT_DIR/scripts/launchd-unit.sh"
    GATE_PID="$(start_launchd_unit "$LABEL" || true)"
    if [ -n "$GATE_PID" ]; then
      echo "Started $LABEL (pid $GATE_PID, every 300s)."
    else
      echo "WARN: $LABEL written but NOT verified running -- start it with: launchctl kickstart -p gui/$(id -u)/$LABEL" >&2
    fi
  else
    echo "Installed but NOT started. To start: launchctl bootstrap gui/$(id -u) $PLIST; launchctl kickstart -p gui/$(id -u)/$LABEL"
  fi
else
  UNIT="${SERVICE_ID}-channel-process-gate"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$UNIT.service" <<UNIT_EOF
[Unit]
Description=Channel process gate: a declared channel plugin with no live worker

[Service]
Type=oneshot
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/env python3 $GATE --notify
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=$HOME
Environment=CLAUDE_PROJECT_DIR=$PROJECT_DIR
StandardOutput=append:$LOG
StandardError=append:$LOG
UNIT_EOF
  # No Requires=/Wants= on the triggered service: the [Timer] binds to it by
  # name, and a Wants= there makes every timer activation start the service
  # twice (the same trap the morning and keepalive timers already document).
  cat > "$UNIT_DIR/$UNIT.timer" <<UNIT_EOF
[Unit]
Description=Channel process gate every 5 minutes

[Timer]
OnBootSec=120s
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT_EOF
  echo "Wrote systemd units: $UNIT_DIR/$UNIT.service, $UNIT_DIR/$UNIT.timer"
  if [ "$LOAD" = "1" ]; then
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user enable --now "$UNIT.timer" 2>/dev/null; then
      echo "Started $UNIT.timer (every 5 min)."
    else
      echo "WARN: $UNIT.timer written but not enabled -- run: systemctl --user enable --now $UNIT.timer" >&2
    fi
  else
    echo "Installed but NOT started. To start: systemctl --user enable --now $UNIT.timer"
  fi
fi
