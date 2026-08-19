#!/bin/bash
# Install the artifact-store-sync PostToolUse hook into every fleet agent's
# .claude/settings.json and the root .claude/settings.json (main agent).
#
# The hook catches every successful Artifact tool publish and mirrors the
# content to the local DB via POST /api/artifacts, so cloud artifacts are
# always present in the local store regardless of whether an agent's CLAUDE.md
# has the "Artifact házirendje" reminder.
#
# Idempotent: safe to run multiple times and via sync-hooks.sh.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_SRC="$REPO_DIR/scripts/hooks/artifact-store-sync.py"

if [ ! -f "$HOOK_SRC" ]; then
  echo "❌ Hook source not found: $HOOK_SRC" >&2
  exit 1
fi

# ---- helper: patch one settings.json idempotently -------------------------
patch_settings() {
  local settings_file="$1"
  if [ ! -f "$settings_file" ]; then
    return 0
  fi
  python3 - "$settings_file" "$HOOK_SRC" <<'PYEOF'
import json, sys, os

settings_path = sys.argv[1]
hook_cmd = f'python3 {sys.argv[2]}'

with open(settings_path) as f:
    cfg = json.load(f)

hooks = cfg.setdefault('hooks', {})
post = hooks.setdefault('PostToolUse', [])

# Idempotent + no-duplicate: skip if ANY Artifact matcher is already present.
# This also covers the canonical entry shipped in the git-tracked root
# settings.json (which uses the portable "$CLAUDE_PROJECT_DIR" path form) so we
# never append a second, absolute-path Artifact hook alongside it.
for entry in post:
    if entry.get('matcher') == 'Artifact':
        print(f"  ⊙ already installed in {os.path.basename(settings_path)}")
        sys.exit(0)

# Insert new matcher entry
post.append({
    'matcher': 'Artifact',
    'hooks': [{
        'type': 'command',
        'command': hook_cmd,
        'timeout': 10,
    }],
})

with open(settings_path, 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')

print(f"  ✓ patched {settings_path}")
PYEOF
}

# ---- patch root settings (main agent / jarvis) ----------------------------
ROOT_SETTINGS="$REPO_DIR/.claude/settings.json"
echo "→ root agent"
patch_settings "$ROOT_SETTINGS"

# ---- patch every sub-agent ------------------------------------------------
AGENTS_DIR="$REPO_DIR/agents"
if [ -d "$AGENTS_DIR" ]; then
  for agent_dir in "$AGENTS_DIR"/*/; do
    agent_name="$(basename "$agent_dir")"
    agent_settings="$agent_dir.claude/settings.json"
    echo "→ $agent_name"
    patch_settings "$agent_settings"
  done
fi

echo ""
echo "✓ artifact-store-sync hook installed."
echo "  Cloud Artifact publishes are now mirrored to /api/artifacts automatically."
