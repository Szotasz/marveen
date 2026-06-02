#!/bin/bash
# install-channel-coordinator.sh
#
# Installs the marveen-channel-coordinator launchd unit (macOS). This is the
# CUTOVER entry point for the channel-ingest decoupling -- it is intentionally
# NOT run by the normal setup. Run it deliberately, after review, when ready to
# move inbound Telegram polling from the in-TUI plugin to the standalone poller.
#
# Steps performed:
#   1. Verify the build artifact (dist/channel-coordinator.js) exists.
#   2. Provision the coordinator STATE_DIR (~/.claude/channels/telegram-coordinator)
#      and copy the bot token into its 0600 .env (NOT exported to any shell env).
#   3. Apply the plugin outbound-only guard (scripts/patch-telegram-outbound-only.sh).
#   4. Write ~/Library/LaunchAgents/com.marveen.channel-coordinator.plist.
#   5. With --load: launchctl load the unit (starts polling). Without --load:
#      install only, so you can do the channels.sh restart + load in your own
#      controlled cutover window.
#
# Usage:
#   scripts/install-channel-coordinator.sh            # install, do not start
#   scripts/install-channel-coordinator.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LABEL="com.marveen.channel-coordinator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
COORD_STATE_DIR="$HOME/.claude/channels/telegram-coordinator"
DIST_ENTRY="$PROJECT_DIR/dist/channel-coordinator.js"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

# 1. build artifact
if [ ! -f "$DIST_ENTRY" ]; then
  echo "ERROR: $DIST_ENTRY not found. Run 'npm run build' first." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH" >&2
  exit 1
fi

# 2. coordinator STATE_DIR + token (own .env, 0600, never exported)
mkdir -p "$COORD_STATE_DIR"
chmod 700 "$COORD_STATE_DIR"
if [ ! -f "$COORD_STATE_DIR/.env" ]; then
  TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$PROJECT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -z "$TOKEN" ]; then
    echo "ERROR: TELEGRAM_BOT_TOKEN not found in $PROJECT_DIR/.env" >&2
    exit 1
  fi
  umask 077
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" > "$COORD_STATE_DIR/.env"
  chmod 600 "$COORD_STATE_DIR/.env"
  unset TOKEN
  echo "Wrote coordinator token to $COORD_STATE_DIR/.env (0600)"
else
  echo "Coordinator .env already present, leaving as-is: $COORD_STATE_DIR/.env"
fi

# 3. plugin outbound-only guard
bash "$SCRIPT_DIR/patch-telegram-outbound-only.sh"

# 4. launchd plist (env block mirrors com.marveen.channels.plist)
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
    <string>$NODE_BIN</string>
    <string>$DIST_ENTRY</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/store/channel-coordinator.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/store/channel-coordinator.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$(id -un)</string>
    <key>TERM</key>
    <string>xterm-256color</string>
    <key>LANG</key>
    <string>hu_HU.UTF-8</string>
    <key>COORDINATOR_STATE_DIR</key>
    <string>$COORD_STATE_DIR</string>
  </dict>
</dict>
</plist>
PLIST_EOF
echo "Wrote launchd unit: $PLIST"

# 5. optional load
if [ "$LOAD" = "1" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Loaded $LABEL (coordinator polling). Remember: set COORDINATOR_INBOUND=1 in .env and restart channels.sh so the plugin goes outbound-only."
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
  echo "Cutover reminder: set COORDINATOR_INBOUND=1 in .env, restart channels.sh (plugin -> outbound-only), then load this unit."
fi
