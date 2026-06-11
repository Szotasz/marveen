#!/bin/bash
# Install the Telegram "working…" progress indicator: hooks + a standalone
# watchdog (sentry). Plugin-independent — needs no changes to the official
# telegram plugin, so it survives plugin updates.
#
# What you get:
#   - inbound Telegram message  -> a "✍️ Dolgozom rajta…" placeholder appears
#   - the agent sends a reply   -> the placeholder is deleted the instant the
#                                  answer goes out (PostToolUse), Stop as fallback
#   - the turn never finishes    -> a watchdog rewrites the placeholder into a
#     (crash/wedged/agent down)    clear error, so the user always gets either an
#                                  answer or an explicit failure
#
# What it does:
#   1. Copies the 4 hook scripts to ~/.claude/hooks/
#   2. Patches ~/.claude/settings.json idempotently:
#        UserPromptSubmit -> telegram_progress.py
#        PostToolUse(telegram.*reply) -> telegram_progress_reply_clear.py
#        Stop -> telegram_progress_clear.py
#   3. Installs the watchdog as a launchd agent (macOS) or systemd
#      service+timer (Linux), running ~every 60s.
#
# Idempotent: safe to re-run (e.g. from sync-hooks.sh on every update).
#
# Usage:
#   bash ~/ClaudeClaw/scripts/install-telegram-progress-hook.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/hooks"
DEST_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

SUBMIT_HOOK="$DEST_DIR/telegram_progress.py"
STOP_HOOK="$DEST_DIR/telegram_progress_clear.py"
REPLY_HOOK="$DEST_DIR/telegram_progress_reply_clear.py"
WATCHDOG="$DEST_DIR/telegram_progress_watchdog.py"

for f in telegram_progress.py telegram_progress_clear.py \
         telegram_progress_reply_clear.py telegram_progress_watchdog.py; do
  if [ ! -f "$SRC_DIR/$f" ]; then
    echo "❌ Source hook not found: $SRC_DIR/$f" >&2
    exit 1
  fi
done

mkdir -p "$DEST_DIR"
cp "$SRC_DIR/telegram_progress.py"             "$SUBMIT_HOOK"
cp "$SRC_DIR/telegram_progress_clear.py"       "$STOP_HOOK"
cp "$SRC_DIR/telegram_progress_reply_clear.py" "$REPLY_HOOK"
cp "$SRC_DIR/telegram_progress_watchdog.py"    "$WATCHDOG"
chmod +x "$SUBMIT_HOOK" "$STOP_HOOK" "$REPLY_HOOK" "$WATCHDOG"
echo "✓ Hooks installed in $DEST_DIR"

if [ ! -f "$SETTINGS" ]; then
  echo '{"hooks":{}}' > "$SETTINGS"
fi

# Resolve an absolute python3 for both the hooks and the daemon unit.
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "❌ python3 not found in PATH" >&2
  exit 1
fi

# --- Patch settings.json idempotently --------------------------------------
"$PY" - "$SETTINGS" "$PY" "$SUBMIT_HOOK" "$STOP_HOOK" "$REPLY_HOOK" <<'PYEOF'
import json, sys

settings_path, py, submit_hook, stop_hook, reply_hook = sys.argv[1:6]
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

# Stop (no matcher) -> clear fallback
stop = hooks.setdefault('Stop', [])
if not has_command(stop, cmd(stop_hook)):
    grp = next((g for g in stop if 'matcher' not in g), None)
    if grp is None:
        grp = {'hooks': []}
        stop.append(grp)
    grp.setdefault('hooks', []).append(
        {'type': 'command', 'command': cmd(stop_hook), 'timeout': 15})
    changed = True

# PostToolUse(matcher="telegram.*reply") -> clear on reply
post = hooks.setdefault('PostToolUse', [])
if not has_command(post, cmd(reply_hook), matcher='telegram.*reply'):
    grp = find_group(post, 'telegram.*reply')
    if grp is None:
        grp = {'matcher': 'telegram.*reply', 'hooks': []}
        post.append(grp)
    grp.setdefault('hooks', []).append(
        {'type': 'command', 'command': cmd(reply_hook), 'timeout': 15})
    changed = True

if changed:
    with open(settings_path, 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print("✓ settings.json hooks patched (UserPromptSubmit / PostToolUse / Stop)")
else:
    print("⊙ settings.json already has the progress hooks — skipping")
PYEOF

# --- Install the watchdog daemon -------------------------------------------
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  LABEL="com.marveen.telegram-progress-watchdog"
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
  SVC="marveen-telegram-progress-watchdog"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SVC.service" <<UNITEOF
[Unit]
Description=Marveen Telegram progress-indicator watchdog (sentry)

[Service]
Type=oneshot
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
    echo "✓ Watchdog installed (systemd timer: $SVC.timer, every 60s)"
  else
    echo "⚠ systemd --user not available — units written to $UNIT_DIR"
    echo "  Enable later: systemctl --user enable --now $SVC.timer"
  fi
fi

echo ""
echo "Done. Telegram turns now show a 'Dolgozom rajta…' placeholder that clears"
echo "on reply, and a watchdog turns any stuck turn into a clear error."
