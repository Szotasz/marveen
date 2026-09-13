#!/bin/bash
# install-channel-outage-alarm.sh
#
# Installs the launchd unit for scripts/channel-outage-alarm.sh (CHANALARM912),
# the out-of-band alarm that tells the owner when the Telegram channel is down.
#
# WHY IT IS SEPARATE FROM EVERY OTHER WATCHER. On 2026-09-12 the main agent was
# silent on Telegram for 8h23m (05:03-13:26). Detection was never the gap:
# channel-keepalive-probe.sh logged 139 consecutive WARN lines naming the exact
# fault. Nothing read that log, and the only path to the owner was the very
# channel that was down. This unit therefore shares nothing with what it
# watches -- no dashboard, no claude session, no telegram plugin, just curl
# against api.telegram.org.
#
# Cadence and thresholds live in the script itself; the unit only has to run it
# often enough to resolve them:
#   StartInterval 180   -- the same ~3 min cadence as the keepalive probe, so
#                          the 9/15/30-minute thresholds land where intended
#   RunAtLoad true      -- an immediate first run is safe: the script is
#                          idempotent and stays silent while healthy
#
# PATH MATTERS HERE, unlike in the keepalive-probe unit. The once-per-boot
# report reads the boot time from `sysctl -n kern.boottime`, and sysctl lives in
# /usr/sbin -- absent from many inherited PATHs. The script names absolute paths
# for exactly that reason, but the unit's PATH carries /usr/sbin:/sbin too, so
# neither layer alone has to be right. A silently disabled boot reporter looks
# exactly like a boot that never happened.
#
# Usage:
#   scripts/install-channel-outage-alarm.sh            # install, do not start
#   scripts/install-channel-outage-alarm.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LABEL="com.marveen.channel-outage-alarm"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ALARM="$PROJECT_DIR/scripts/channel-outage-alarm.sh"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

if [ ! -f "$ALARM" ]; then
  echo "ERROR: $ALARM not found." >&2
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
    <string>$ALARM</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>180</integer>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/store/channel-outage-alarm.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/store/channel-outage-alarm.stdout.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
  echo "Loaded $LABEL (every 180s + at load). It stays silent while the channel is healthy; it messages the owner directly over the Bot API once the keepalive has been stale for 15 minutes, whether or not its one restart attempt helped."
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
fi
