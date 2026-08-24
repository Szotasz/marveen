#!/bin/bash
# Installer for the marveen.io agent security package.
#
# DEFAULT TARGET: the CURRENT PROJECT's .claude/ directory. The global
# ~/.claude/ is only touched when you explicitly pass --global, and the
# installer always prints where every file went. (Rationale: a package meant
# for one project must not silently land in every project's context; on some
# setups .claude-config/skills is a symlink to the global skill dir.)
#
# Usage:
#   ./install.sh                 # install into ./.claude of the current dir
#   ./install.sh --target DIR    # install into DIR/.claude
#   ./install.sh --global        # install into ~/.claude (explicit choice)
#   add --write-settings to merge the hook block into settings.json;
#   without it the installer PRINTS the block and you add it yourself.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="$(pwd)"
GLOBAL=0
WRITE_SETTINGS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --global) GLOBAL=1; TARGET_ROOT="$HOME"; shift ;;
    --target) TARGET_ROOT="$2"; shift 2 ;;
    --write-settings) WRITE_SETTINGS=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

CLAUDE_DIR="$TARGET_ROOT/.claude"
if [[ $GLOBAL -eq 1 ]]; then
  echo "NOTE: --global installs into $CLAUDE_DIR. Hooks and helpers placed"
  echo "here apply to EVERY project this machine runs. If that is not what"
  echo "you want, re-run without --global from your project directory."
fi

mkdir -p "$CLAUDE_DIR/mio/bin" "$CLAUDE_DIR/mio/hooks" "$CLAUDE_DIR/skills/mio-agent-security"

install -m 755 "$SRC/bin/mio-scan"   "$CLAUDE_DIR/mio/bin/mio-scan"
install -m 755 "$SRC/bin/mio-fetch"  "$CLAUDE_DIR/mio/bin/mio-fetch"
install -m 755 "$SRC/bin/mio-upload" "$CLAUDE_DIR/mio/bin/mio-upload"
install -m 755 "$SRC/hooks/mio-gate.sh" "$CLAUDE_DIR/mio/hooks/mio-gate.sh"
install -m 644 "$SRC/skill/SKILL.md" "$CLAUDE_DIR/skills/mio-agent-security/SKILL.md"
install -m 644 "$SRC/attestation-schema.json" "$CLAUDE_DIR/mio/attestation-schema.json"

echo "Installed:"
echo "  $CLAUDE_DIR/mio/bin/mio-scan"
echo "  $CLAUDE_DIR/mio/bin/mio-fetch"
echo "  $CLAUDE_DIR/mio/bin/mio-upload"
echo "  $CLAUDE_DIR/mio/hooks/mio-gate.sh"
echo "  $CLAUDE_DIR/skills/mio-agent-security/SKILL.md"
echo "  $CLAUDE_DIR/mio/attestation-schema.json"

HOOK_PATH_VAR='$CLAUDE_PROJECT_DIR/.claude/mio/hooks/mio-gate.sh'
if [[ $GLOBAL -eq 1 ]]; then
  HOOK_PATH_VAR="$CLAUDE_DIR/mio/hooks/mio-gate.sh"
fi

HOOK_BLOCK=$(cat << EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WebFetch|Bash",
        "hooks": [ { "type": "command", "command": "$HOOK_PATH_VAR" } ]
      }
    ]
  }
}
EOF
)

SETTINGS="$CLAUDE_DIR/settings.json"
if [[ $WRITE_SETTINGS -eq 1 ]]; then
  MIO_HOOK_CMD="$HOOK_PATH_VAR" python3 - "$SETTINGS" << 'PYEOF'
import json, os, sys
path = sys.argv[1]
cmd = os.environ["MIO_HOOK_CMD"]
try:
    with open(path) as fh:
        settings = json.load(fh)
except FileNotFoundError:
    settings = {}
hooks = settings.setdefault("hooks", {})
pre = hooks.setdefault("PreToolUse", [])
entry = {"matcher": "WebFetch|Bash",
         "hooks": [{"type": "command", "command": cmd}]}
if not any(h.get("command") == cmd
           for m in pre for h in m.get("hooks", [])):
    pre.append(entry)
with open(path, "w") as fh:
    json.dump(settings, fh, indent=2)
print(f"settings updated: {path}")
PYEOF
else
  echo
  echo "Add this to $SETTINGS (or re-run with --write-settings):"
  echo "$HOOK_BLOCK"
fi

echo
echo "Put $CLAUDE_DIR/mio/bin on PATH for the agent (or reference the tools"
echo "by absolute path). Set MIO_MEMBER_ID and MIO_ATTEST_KEY from your"
echo "marveen.io profile before using mio-upload."
