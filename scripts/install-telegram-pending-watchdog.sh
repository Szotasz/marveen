#!/bin/bash
# install-telegram-pending-watchdog.sh
#
# Installs the launchd job (macOS) for scripts/telegram-pending-watchdog.py: every 180 s it asks the Bot API
# how many updates wait for each bot of this install, and restarts an agent whose poller has stopped
# polling (pending > 0 in two consecutive runs, >= 170 s apart, i.e. ~3 min; max one restart attempt / agent / 15 min).
# See the script's header for why (TGPENDING1016).
#
# Opt-in: update.sh does not install it. It restarts agents, so the operator turns it on.
#
# Usage:
#   scripts/install-telegram-pending-watchdog.sh            # install, do not start
#   scripts/install-telegram-pending-watchdog.sh --load     # install and start
#   scripts/install-telegram-pending-watchdog.sh --print-label

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# #1873: com.<SERVICE_ID>.<name>, so two installs under one user do not share one helper job.
. "$SCRIPT_DIR/launchd-label.sh"
LABEL="$(helper_launchd_label "$PROJECT_DIR" telegram-pending-watchdog)"
if [ "${1:-}" = "--print-label" ]; then printf '%s\n' "$LABEL"; exit 0; fi
PLIST_DIR="${TPW_PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$PLIST_DIR/$LABEL.plist"
WATCHDOG="$PROJECT_DIR/scripts/telegram-pending-watchdog.py"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

if [ ! -f "$WATCHDOG" ]; then
  echo "ERROR: $WATCHDOG not found." >&2
  exit 1
fi
PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ]; then
  echo "ERROR: python3 not on PATH." >&2
  exit 1
fi

mkdir -p "$PLIST_DIR"
# ISSUE1895: TZ only when the operator pinned one (SCHEDULER_TZ), as the other helpers do.
. "$SCRIPT_DIR/lib/install-tz.sh"
PINNED_TZ="$(install_tz_pinned "$PROJECT_DIR")"
TZ_XML=""
if [ -n "$PINNED_TZ" ]; then
  TZ_XML="
    <key>TZ</key>
    <string>$PINNED_TZ</string>"
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
    <string>$PYTHON</string>
    <string>$WATCHDOG</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>180</integer>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/store/telegram-pending-watchdog.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/store/telegram-pending-watchdog.log</string>
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
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Loaded $LABEL (every 180s + at load). Log: $PROJECT_DIR/store/telegram-pending-watchdog.log"
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
fi
