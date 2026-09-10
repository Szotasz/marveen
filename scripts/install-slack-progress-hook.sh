#!/bin/bash
# Install the Slack "working…" progress indicator: hooks + a standalone
# watchdog (sentry). Mirrors install-telegram-progress-hook.sh exactly, using
# the Slack Web API (chat.postMessage / chat.delete / chat.update) instead of
# the Bot API. Plugin-independent — needs no changes to the Slack channel
# plugin, so it survives plugin updates.
#
# Why not Slack's "typing…" indicator: the classic RTM `type: typing` frame
# is not available to modern (Web API / Socket Mode) Slack apps, so there is
# no bot-side typing bubble to use — same situation as Telegram, same fix.
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
# What it does:
#   1. Copies the 4 hook scripts to ~/.claude/hooks/
#   2. Patches ~/.claude/settings.json idempotently:
#        UserPromptSubmit -> slack_progress.py
#        PostToolUse(matcher="slack.*reply")
#          -> slack_progress_reply_clear.py
#        Stop -> slack_progress_clear.py
#   3. Retires the Telegram progress plumbing (hooks + watchdog) so exactly
#      one provider's indicator is live -- see retire-progress-watchdog.sh.
#   4. Installs the watchdog as a launchd agent (macOS) or systemd
#      service+timer (Linux), running ~every 60s.
#
# The PostToolUse matcher is a loose regex ("slack.*reply") that matches the
# real reply tool name mcp__plugin_slack-channel_slack__reply regardless of the
# exact plugin id. If a given install needs a stricter/different matcher,
# override it via SLACK_REPLY_TOOL_MATCHER before running this script — the hook
# scripts themselves only check that the tool name contains "slack"+"reply",
# so they are robust to the exact plugin id either way.
#
# Idempotent: safe to re-run (e.g. from sync-hooks.sh on every update).
#
# Usage:
#   bash ~/ClaudeClaw/scripts/install-slack-progress-hook.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/hooks"
DEST_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Read a single key from a .env file without sourcing it (see
# install-telegram-progress-hook.sh for why: sourcing an unquoted
# space-containing or $(...) value can run arbitrary code).
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

# The real tool name is mcp__plugin_slack-channel_slack__reply (server name is
# `slack`, not `slack-channel`). A loose regex "slack.*reply" matches it and is
# robust to plugin-id variations, mirroring the Telegram matcher "telegram.*reply".
REPLY_MATCHER="${SLACK_REPLY_TOOL_MATCHER:-slack.*reply}"

SUBMIT_HOOK="$DEST_DIR/slack_progress.py"
STOP_HOOK="$DEST_DIR/slack_progress_clear.py"
REPLY_HOOK="$DEST_DIR/slack_progress_reply_clear.py"
WATCHDOG="$DEST_DIR/slack_progress_watchdog.py"

for f in slack_progress.py slack_progress_clear.py \
         slack_progress_reply_clear.py slack_progress_watchdog.py; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "❌ Source hook not found: $SRC_DIR/$f" >&2
    exit 1
  fi
done

mkdir -p "$DEST_DIR"
cp "$SRC_DIR/slack_progress.py"             "$SUBMIT_HOOK"
cp "$SRC_DIR/slack_progress_clear.py"       "$STOP_HOOK"
cp "$SRC_DIR/slack_progress_reply_clear.py" "$REPLY_HOOK"
cp "$SRC_DIR/slack_progress_watchdog.py"    "$WATCHDOG"
chmod +x "$SUBMIT_HOOK" "$STOP_HOOK" "$REPLY_HOOK" "$WATCHDOG"
echo "✓ Hooks installed in $DEST_DIR"

if [ ! -f "$SETTINGS" ]; then
  echo '{"hooks":{}}' > "$SETTINGS"
fi

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "❌ python3 not found in PATH" >&2
  exit 1
fi

# --- Patch settings.json idempotently --------------------------------------
# PYTHONIOENCODING pins stdout to utf-8 so the checkmark below can't crash the
# installer on a platform whose default console codec (e.g. Windows cp1252)
# can't encode it.
PYTHONIOENCODING=utf-8 "$PY" - "$SETTINGS" "$PY" "$SUBMIT_HOOK" "$STOP_HOOK" "$REPLY_HOOK" "$REPLY_MATCHER" <<'PYEOF'
import json, sys

settings_path, py, submit_hook, stop_hook, reply_hook, reply_matcher = sys.argv[1:7]
with open(settings_path) as f:
    cfg = json.load(f)
hooks = cfg.setdefault('hooks', {})

def cmd(path):
    return f"{py} {path}"

def has_command(group_list, command, matcher=None):
    for g in group_list:
        if matcher is not None and g.get('matcher') != matcher:
            continue
        for h in g.get('hooks', []):
            if h.get('command') == command:
                return True
    return False

def find_group(group_list, matcher):
    for g in group_list:
        if g.get('matcher') == matcher:
            return g
    return None

changed = False

# UserPromptSubmit (no matcher) -> placeholder
ups = hooks.setdefault('UserPromptSubmit', [])
if not has_command(ups, cmd(submit_hook)):
    grp = next((g for g in ups if 'matcher' not in g), None)
    if grp is None:
        grp = {'hooks': []}
        ups.append(grp)
    grp.setdefault('hooks', []).append(
        {'type': 'command', 'command': cmd(submit_hook), 'timeout': 15})
    changed = True

# Stop (no matcher) -> clear + enforce-delivery fallback
stop = hooks.setdefault('Stop', [])
if not has_command(stop, cmd(stop_hook)):
    grp = next((g for g in stop if 'matcher' not in g), None)
    if grp is None:
        grp = {'hooks': []}
        stop.append(grp)
    grp.setdefault('hooks', []).append(
        {'type': 'command', 'command': cmd(stop_hook), 'timeout': 15})
    changed = True

# PostToolUse(matcher=reply_matcher) -> clear on reply
post = hooks.setdefault('PostToolUse', [])
if not has_command(post, cmd(reply_hook), matcher=reply_matcher):
    grp = find_group(post, reply_matcher)
    if grp is None:
        grp = {'matcher': reply_matcher, 'hooks': []}
        post.append(grp)
    grp.setdefault('hooks', []).append(
        {'type': 'command', 'command': cmd(reply_hook), 'timeout': 15})
    changed = True

if changed:
    with open(settings_path, 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print("✓ settings.json hooks patched (UserPromptSubmit / PostToolUse / Stop)")
else:
    print("⊙ settings.json already has the Slack progress hooks — skipping")
PYEOF

# --- Retire the other provider's progress plumbing -------------------------
# Installing Slack does not automatically unwire Telegram: after a migration
# both hook sets stayed in settings.json and BOTH watchdog timers kept firing,
# the dead one scanning state dirs that no longer existed 1440x/day. Exactly
# one provider's progress machinery should be live -- the one in
# CHANNEL_PROVIDER. Never fatal: a failure here must not block the install.
bash "$INSTALL_DIR/scripts/retire-progress-watchdog.sh" telegram || true

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
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
  echo "✓ Watchdog installed (launchd: $LABEL, every 60s)"
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
    echo "✓ Watchdog installed (systemd timer: $SVC.timer, every 60s)"
  else
    echo "⚠ systemd --user not available — units written to $UNIT_DIR"
    echo "  Enable later: systemctl --user enable --now $SVC.timer"
  fi
fi

echo ""
echo "Done. Slack turns now show a 'Dolgozom rajta…' placeholder that clears"
echo "on reply, and a watchdog turns any stuck turn into a clear error."
