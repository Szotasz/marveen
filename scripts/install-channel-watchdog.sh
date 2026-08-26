#!/bin/bash
# install-channel-watchdog.sh
#
# Installs the launchd unit for scripts/channel-watchdog.sh on macOS.
# Without this unit the watchdog script -- which detects a stale main session
# and respawns it -- never runs automatically. The corresponding systemd timer
# (scripts/systemd/channel-watchdog.timer, OnActiveSec=5min) already exists for
# Linux; this script provides parity on macOS.
#
# The watchdog fires every 5 minutes (StartInterval 300), matching the systemd
# cadence. RunAtLoad is false: the channels session is not guaranteed to exist
# yet at boot, and the first sweep 5 minutes later is early enough.
#
# IMPORTANT: this unit complements, but does NOT replace, the
# com.jarvis.channels KeepAlive plist. The
# watchdog handles the "session stuck / wedged" case; launchd KeepAlive handles
# the "session exited cleanly" case. Both are needed for full coverage.
#
# Usage:
#   scripts/install-channel-watchdog.sh            # install, do not start
#   scripts/install-channel-watchdog.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LABEL="com.jarvis.channel-watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WATCHDOG="$PROJECT_DIR/scripts/channel-watchdog.sh"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

if [ ! -f "$WATCHDOG" ]; then
  echo "ERROR: $WATCHDOG not found." >&2
  exit 1
fi

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
    <string>/bin/bash</string>
    <string>$WATCHDOG</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <false/>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/store/channel-watchdog.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/store/channel-watchdog.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$(id -un)</string>
    <key>TZ</key>
    <string>Europe/Budapest</string>
  </dict>
</dict>
</plist>
PLIST_EOF
echo "Wrote launchd unit: $PLIST"

if [ "$LOAD" = "1" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Loaded $LABEL (every 300s, not at load). Watchdog will sweep the main channel session every 5 minutes."
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
fi
