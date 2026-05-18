#!/bin/bash
# Install the channel-image-resize PreToolUse hook into ~/.claude/.
# Protects against large channel-received images filling the context window.
# Works for any channel provider (Telegram, Slack, etc.).
#
# What it does:
#   1. Copies the hook to ~/.claude/hooks/channel-image-resize.sh
#   2. Patches ~/.claude/settings.json hooks.PreToolUse idempotently
#
# Also migrates the old telegram-image-resize.sh hook if present.
#
# Usage:
#   bash ~/ClaudeClaw/scripts/install-channel-image-hook.sh

set -euo pipefail

REPO_HOOK="$(cd "$(dirname "$0")" && pwd)/hooks/channel-image-resize.sh"
DEST_HOOK="$HOME/.claude/hooks/channel-image-resize.sh"
OLD_HOOK="$HOME/.claude/hooks/telegram-image-resize.sh"
SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$REPO_HOOK" ]; then
  echo "❌ Source hook not found at $REPO_HOOK" >&2
  exit 1
fi

mkdir -p "$HOME/.claude/hooks"
cp "$REPO_HOOK" "$DEST_HOOK"
chmod +x "$DEST_HOOK"
echo "✓ Hook installed: $DEST_HOOK"

if [ ! -f "$SETTINGS" ]; then
  # Bootstrap minimal settings.json
  echo '{"hooks":{"PreCompact":[],"PreToolUse":[],"PostToolUse":[]}}' > "$SETTINGS"
fi

# Patch settings.json idempotently via Python (handles JSON parse + dedup)
python3 - "$SETTINGS" "$DEST_HOOK" <<'PYEOF'
import json, sys

settings_path, hook_path = sys.argv[1], sys.argv[2]
with open(settings_path) as f:
    cfg = json.load(f)

hooks = cfg.setdefault('hooks', {})
pre = hooks.setdefault('PreToolUse', [])

# Already installed?
for matcher in pre:
    if matcher.get('matcher') != 'Read':
        continue
    for h in matcher.get('hooks', []):
        if h.get('command') == hook_path:
            print(f"⊙ Already in settings.json — skipping")
            sys.exit(0)

# Insert
read_matcher = None
for matcher in pre:
    if matcher.get('matcher') == 'Read':
        read_matcher = matcher
        break

if read_matcher is None:
    read_matcher = {'matcher': 'Read', 'hooks': []}
    pre.append(read_matcher)

read_matcher['hooks'].append({
    'type': 'command',
    'command': hook_path,
    'timeout': 15,
})

with open(settings_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
print(f"✓ Added PreToolUse hook for Read tool in {settings_path}")
PYEOF

# Migrate old hook: remove telegram-image-resize.sh from settings and disk
if [ -f "$OLD_HOOK" ]; then
  rm -f "$OLD_HOOK"
  python3 - "$SETTINGS" "$OLD_HOOK" <<'MIGRATEOF'
import json, sys

settings_path, old_path = sys.argv[1], sys.argv[2]
try:
    with open(settings_path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)

pre = cfg.get('hooks', {}).get('PreToolUse', [])
changed = False
for matcher in pre:
    hooks = matcher.get('hooks', [])
    new_hooks = [h for h in hooks if h.get('command') != old_path]
    if len(new_hooks) != len(hooks):
        matcher['hooks'] = new_hooks
        changed = True

if changed:
    with open(settings_path, 'w') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print(f"  Migrated: removed old telegram-image-resize.sh from settings")
MIGRATEOF
fi

echo ""
echo "Done. Channel-received images >500KB will be auto-resized."
echo "   Originals preserved at ~/.claude/channels/<provider>/inbox/original/<filename>"
