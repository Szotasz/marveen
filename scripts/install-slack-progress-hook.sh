#!/bin/bash
# Install the Slack progress-indicator WATCHDOG (sentry) daemon. Mirrors
# install-telegram-progress-hook.sh, using the Slack Web API
# (chat.postMessage / chat.delete / chat.update) instead of the Bot API.
# Plugin-independent - needs no changes to the Slack channel plugin, so it
# survives plugin updates.
#
# Why not Slack's "typing…" indicator: the classic RTM `type: typing` frame
# is not available to modern (Web API / Socket Mode) Slack apps, so there is
# no bot-side typing bubble to use - same situation as Telegram, same fix.
#
# What you get:
#   - inbound Slack message    -> a "✍️ Dolgozom rajta…" placeholder appears
#                                  (in-thread if the inbound message was)
#   - the agent sends a reply  -> the placeholder is deleted the instant the
#                                  answer goes out (PostToolUse), Stop as fallback
#   - the turn never finishes   -> a watchdog rewrites the placeholder into a
#     (crash/wedged/agent down)   clear error, so the user always gets either an
#                                  answer or an explicit failure
#
# Since #1305 (ISSUE1305HOOKSCOPE) this installer no longer touches
# ~/.claude/settings.json and no longer copies hook files into ~/.claude/hooks:
# writing fleet hooks into the user-global settings made them fire in the
# owner's own, unrelated Claude Code sessions. The three settings hooks
# (UserPromptSubmit -> slack_progress.py, PostToolUse("slack.*reply") ->
# slack_progress_reply_clear.py, Stop -> slack_progress_clear.py) are
# repo-shipped in the tracked <repo>/.claude/settings.json (project scope,
# $CLAUDE_PROJECT_DIR form) and seeded into every agent from
# templates/settings.json.template -- nothing to install for them. The fixed
# PostToolUse matcher there is the loose regex "slack.*reply", which matches
# the real tool name mcp__plugin_slack-channel_slack__reply regardless of the
# exact plugin id (the hook scripts themselves only check that the tool name
# contains "slack"+"reply", so they are robust either way).
#
# What it does:
#   0. Provider gate: if CHANNEL_PROVIDER (install .env) is not "slack", it
#      retires any leftover Slack plumbing and exits with that retire's status
#      (0 unless it failed) -- nothing below runs.
#      This is what keeps sync-hooks.sh (which runs every installer on every
#      update) from resurrecting the retired provider.
#   1. Retires the Telegram progress plumbing (hooks + watchdog) so exactly
#      one provider's indicator is live -- see retire-progress-watchdog.sh.
#      A failing retire never blocks step 2, but it is printed and becomes
#      the exit code: a cleanup that did not happen is never silent.
#   2. Installs slack_progress_watchdog.py -- the one piece that is not a
#      Claude Code hook at all -- as a launchd agent (macOS) or systemd user
#      service+timer (Linux), running ~every 60s straight from the repo
#      checkout (no ~/.claude/hooks copy, so the daemon can never drift from
#      the repo). The watchdog is the only layer that can speak when the agent
#      itself is down.
#
# Idempotent: safe to re-run (e.g. from sync-hooks.sh on every update).
# Cleanup of the old ~/.claude/hooks copies and stale user-global settings
# entries is the retire script's job, not this one's.
#
# Usage:
#   bash ~/ClaudeClaw/scripts/install-slack-progress-hook.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/hooks"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Read a single key from a .env file without sourcing it (see
# install-telegram-progress-hook.sh for why: sourcing an unquoted
# space-containing or $(...) value can run arbitrary code).
# MARVEEN_ENV_FILE is set only by the tests (scripts/__tests__/*progress-hook*),
# which hand the installer a temp .env this way; when unset, the install's own
# .env is read as before.
read_env() {
  local f="${MARVEEN_ENV_FILE:-$INSTALL_DIR/.env}"
  [ -f "$f" ] || return 0
  local v
  v="$(grep -E "^${1}=" "$f" | tail -1)" || return 0
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

# Run the retire script for one provider and SAY SO when it fails; returns the
# script's exit code. It used to be called with an unconditional "|| true",
# which is how a retire script that the macOS /bin/bash (3.2) could not even
# parse went unnoticed: its error vanished, the cleanup never happened, and
# nothing reported either. A failure is still not allowed to abort this
# installer half-way -- but it is never silent, and it reaches the exit code.
retire_provider() {
  local rc=0
  bash "$INSTALL_DIR/scripts/retire-progress-watchdog.sh" "$1" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "⚠ retire-progress-watchdog.sh $1 FAILED (exit $rc) -- the $1 progress plumbing is NOT retired." >&2
    echo "  Fix the error above, then re-run: bash $INSTALL_DIR/scripts/retire-progress-watchdog.sh $1" >&2
  fi
  return "$rc"
}

# --- Provider gate (order-independent) --------------------------------------
# sync-hooks.sh runs EVERY install-*-hook.sh on every update, in glob order
# (slack first, telegram last). Each installer used to wire its own hooks and
# timer unconditionally and only the cross-retire below was guarded, so a
# Slack install ended every update with BOTH providers live: the Telegram
# installer re-wired telegram_progress*.py and re-enabled its timer after this
# script had retired them (its retire of slack was refused by the
# active-provider guard). Exactly one provider's progress machinery may be
# live -- the one in CHANNEL_PROVIDER -- so an installer whose provider is
# not the active one retires ITSELF and stops here, before writing any unit.
# Resolution mirrors src/channel-provider.ts: exact known
# value, anything else (empty, "none", typo) means telegram.
ACTIVE_PROVIDER="$(read_env CHANNEL_PROVIDER | tr -d ' \t\r')"
case "$ACTIVE_PROVIDER" in
  telegram|slack|discord|googlechat|teams) ;;
  *) ACTIVE_PROVIDER="telegram" ;;
esac
if [ "$ACTIVE_PROVIDER" != "slack" ]; then
  echo "⊙ CHANNEL_PROVIDER=$ACTIVE_PROVIDER -- Slack progress indicator not installed; retiring any leftover Slack plumbing"
  # The retire IS this branch's whole job, so its failure is this installer's
  # failure: sync-hooks.sh reports a non-zero installer and carries on.
  RETIRE_RC=0
  retire_provider slack || RETIRE_RC=$?
  exit "$RETIRE_RC"
fi

# The daemon runs the repo copy directly -- no drift-prone ~/.claude/hooks copy.
WATCHDOG="$SRC_DIR/slack_progress_watchdog.py"

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

# --- Retire the other provider's progress plumbing -------------------------
# Installing Slack does not automatically unwire Telegram: after a migration
# both hook sets stayed in settings.json and BOTH watchdog timers kept firing,
# the dead one scanning state dirs that no longer existed 1440x/day. Exactly
# one provider's progress machinery should be live -- the one in
# CHANNEL_PROVIDER. Never fatal: a failure here must not block the install --
# the active provider's watchdog matters more than the dead one's cleanup. It
# is reported on the spot and again at the end, where it becomes the exit code.
RETIRE_RC=0
retire_provider telegram || RETIRE_RC=$?

# --- Install the watchdog daemon -------------------------------------------
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  LABEL="com.${SERVICE_ID}.slack-progress-watchdog"
  PLIST="$PLIST_DIR/$LABEL.plist"
  LOG="$HOME/.claude/channels/slack-progress-watchdog.log"
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
         path when run from the repo copy (see slack_progress_watchdog.py),
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
  SVC="${SERVICE_ID}-slack-progress-watchdog"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SVC.service" <<UNITEOF
[Unit]
Description=${BOT_NAME} Slack progress-indicator watchdog (sentry)

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
Description=Run the Slack progress watchdog every 60s
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
    echo "⚠ systemd --user not available - units written to $UNIT_DIR"
    echo "  Enable later: systemctl --user enable --now $SVC.timer"
  fi
fi

echo ""
echo "Done. The settings hooks are repo-shipped (.claude/settings.json, project"
echo "scope); the watchdog daemon turns any stuck Slack turn into a clear error."

if [ "$RETIRE_RC" -ne 0 ]; then
  echo "" >&2
  echo "⚠ The Slack watchdog IS installed, but retiring the Telegram plumbing failed (exit $RETIRE_RC, see above):" >&2
  echo "  both providers' progress machinery may be live until that retire succeeds." >&2
  exit "$RETIRE_RC"
fi
