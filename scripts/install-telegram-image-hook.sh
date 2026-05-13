#!/bin/bash
# Telepíti a Telegram-image-resize PreToolUse hook-ot a ~/.claude/-be.
# Védelem a nagy Telegram-fogadott képek context-megtelítése ellen.
#
# Mit csinál:
#   1. Bemásolja a hook-ot ~/.claude/hooks/telegram-image-resize.sh-ra
#   2. Beépíti a hook-bejegyzést a ~/.claude/settings.json hooks.PreToolUse-jébe
#      (idempotens — ha már ott van, nem duplikálja)
#
# Használat:
#   bash ~/ClaudeClaw/scripts/install-telegram-image-hook.sh

set -euo pipefail

REPO_HOOK="$(cd "$(dirname "$0")" && pwd)/hooks/telegram-image-resize.sh"
DEST_HOOK="$HOME/.claude/hooks/telegram-image-resize.sh"
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

echo ""
echo "✅ Done. New Marveen sessions will auto-resize Telegram-received images >500KB."
echo "   Originals preserved at ~/.claude/channels/telegram/inbox/original/<filename>"
