#!/bin/bash
# Install the Telegram progress-indicator WATCHDOG (sentry) daemon.
#
# Since #1305 (ISSUE1305HOOKSCOPE) this installer no longer touches
# ~/.claude/settings.json and no longer copies hook files into ~/.claude/hooks:
# writing fleet hooks into the user-global settings made them fire in the
# owner's own, unrelated Claude Code sessions. The three settings hooks
# (UserPromptSubmit -> telegram_progress.py, PostToolUse(telegram.*reply) ->
# telegram_progress_reply_clear.py, Stop -> telegram_progress_clear.py) are
# repo-shipped in the tracked <repo>/.claude/settings.json (project scope,
# $CLAUDE_PROJECT_DIR form) -- nothing to install for them.
#
# What REMAINS here is the piece that is not a Claude Code hook at all:
#   telegram_progress_watchdog.py as a launchd agent (macOS) or systemd user
#   service+timer (Linux), running ~every 60s straight from the repo checkout
#   (no ~/.claude/hooks copy, so the daemon can never drift from the repo).
#   The watchdog is the only layer that can speak when the agent itself is
#   down: it rewrites an orphaned "Dolgozom rajta…" placeholder into a clear
#   error.
#
# Idempotent: safe to re-run (e.g. from sync-hooks.sh on every update).
# Cleanup of the old ~/.claude/hooks copies and stale user-global settings
# entries belongs to the global-prune round, not here.
#
# Usage:
#   bash ~/ClaudeClaw/scripts/install-telegram-progress-hook.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/hooks"

# The watchdog unit/label name keys off SERVICE_ID, matching install-linux.sh's
# ${SERVICE_ID}-dashboard/-channels units and the macOS com.${SERVICE_ID}.*
# launchd labels. Derive it from the install .env so a renamed install
# (BOT_NAME != Marveen) does NOT get an orphaned marveen-* unit left behind.
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Read a single key from a .env file without sourcing it.
# Sourcing executes the file: an unquoted value with spaces (e.g. OWNER_NAME=Foo Bar)
# causes bash to run the trailing word as a command; a $(...) value runs arbitrary code.
# This function uses grep + pure string manipulation -- no eval, no subshell execution.
read_env() {
  [ -f "$INSTALL_DIR/.env" ] || return 0
  local v
  v="$(grep -E "^${1}=" "$INSTALL_DIR/.env" | tail -1)" || return 0
  v="${v#*=}"
  case "$v" in
    '"'*) v="${v#\"}"; v="${v%\"}" ;;
    "'"*) v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}
SERVICE_ID="$(read_env SERVICE_ID)"
MAIN_AGENT_ID_ENV="$(read_env MAIN_AGENT_ID)"
BOT_NAME="$(read_env BOT_NAME)"
SERVICE_ID="${SERVICE_ID:-${MAIN_AGENT_ID_ENV:-marveen}}"
BOT_NAME="${BOT_NAME:-Marveen}"

# The daemon runs the repo copy directly -- no drift-prone ~/.claude/hooks copy.
WATCHDOG="$SRC_DIR/telegram_progress_watchdog.py"

if [ ! -f "$WATCHDOG" ]; then
  echo "❌ Watchdog source not found: $WATCHDOG" >&2
  exit 1
fi

# Resolve an absolute python3 for the daemon unit.
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "❌ python3 not found in PATH" >&2
  exit 1
fi

# --- Install the watchdog daemon -------------------------------------------
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  LABEL="com.${SERVICE_ID}.telegram-progress-watchdog"
  PLIST="$PLIST_DIR/$LABEL.plist"
  LOG="$HOME/.claude/channels/telegram-progress-watchdog.log"
  mkdir -p "$PLIST_DIR" "$HOME/.claude/channels"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PY</string>
        <string>$WATCHDOG</string>
    </array>
    <!-- launchd's default PATH is minimal; the watchdog shells out to tmux. -->
    <!-- MARVEEN_ROOT: launchd passes no shell env to a job, so the watchdog
         cannot see the operator's environment. It self-locates from its own
         path when run from the repo copy (see telegram_progress_watchdog.py),
         but this makes the install root explicit as a belt (TGWDOGVAK913). -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>MARVEEN_ROOT</key>
        <string>$INSTALL_DIR</string>
    </dict>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || true
  echo "✓ Watchdog installed (launchd: $LABEL, every 60s, running $WATCHDOG)"
else
  # Linux: systemd user service + timer
  UNIT_DIR="$HOME/.config/systemd/user"
  SVC="${SERVICE_ID}-telegram-progress-watchdog"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SVC.service" <<UNITEOF
[Unit]
Description=${BOT_NAME} Telegram progress-indicator watchdog (sentry)

[Service]
Type=oneshot
# MARVEEN_ROOT belt (TGWDOGVAK913): the watchdog self-locates from its own path
# when run from the repo copy, but a systemd job gets no shell env either, so
# make the install root explicit here too.
Environment=MARVEEN_ROOT=$INSTALL_DIR
ExecStart=$PY $WATCHDOG
UNITEOF
  cat > "$UNIT_DIR/$SVC.timer" <<TIMEREOF
[Unit]
Description=Run the Telegram progress watchdog every 60s
Requires=$SVC.service

[Timer]
OnBootSec=60
OnUnitActiveSec=60
AccuracySec=10s

[Install]
WantedBy=timers.target
TIMEREOF
  if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable --now "$SVC.timer" 2>/dev/null || true
    echo "✓ Watchdog installed (systemd timer: $SVC.timer, every 60s, running $WATCHDOG)"
  else
    echo "⚠ systemd --user not available — units written to $UNIT_DIR"
    echo "  Enable later: systemctl --user enable --now $SVC.timer"
  fi
fi

echo ""
echo "Done. The settings hooks are repo-shipped (.claude/settings.json, project"
echo "scope); the watchdog daemon turns any stuck Telegram turn into a clear error."
