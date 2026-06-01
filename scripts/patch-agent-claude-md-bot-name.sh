#!/usr/bin/env bash
# Retroactive patch for sub-agent CLAUDE.md files that hard-coded "marveen" as
# the approver/routing target.
#
# Background (2026-06-01, Tanfield/Csaba install): generateClaudeMd() in
# agent-scaffold.ts had literal "Marveen" and "to":"marveen" inside the
# stranger-sender ARANYSZABÁLY block, even though MAIN_AGENT_ID and BOT_NAME
# are the canonical config knobs. Sub-agents installed on a non-marveen main
# bot pinged a non-existent recipient on first-stranger-message and froze.
#
# The source fix lands new agents correctly; this script patches the already-
# deployed sub-agents. It is IDEMPOTENT - re-running it is a no-op.
#
# Usage:
#   scripts/patch-agent-claude-md-bot-name.sh                       # dry-run report
#   scripts/patch-agent-claude-md-bot-name.sh --apply               # write changes
#   scripts/patch-agent-claude-md-bot-name.sh --apply --agents-dir /path/to/agents
#
# Reads MAIN_AGENT_ID and BOT_NAME from $INSTALL_DIR/.env (same convention as
# scripts/channels.sh). Falls back to "marveen"/"Marveen" only if those env
# entries are missing - which means a vanilla marveen install is unaffected
# (the script writes the same string that was already there).

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$INSTALL_DIR/agents"
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --agents-dir) AGENTS_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "ERROR: $INSTALL_DIR/.env not found - cannot resolve MAIN_AGENT_ID/BOT_NAME" >&2
  exit 1
fi

MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- || true)"
BOT_NAME="$(grep -E '^BOT_NAME=' "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- || true)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
BOT_NAME="${BOT_NAME:-Marveen}"

if [ "$MAIN_AGENT_ID" = "marveen" ] && [ "$BOT_NAME" = "Marveen" ]; then
  echo "Install resolves to MAIN_AGENT_ID=marveen / BOT_NAME=Marveen - no patch needed."
  echo "(The hardcoded strings already match this install's canonical values.)"
  exit 0
fi

if [ ! -d "$AGENTS_DIR" ]; then
  echo "ERROR: agents dir not found: $AGENTS_DIR" >&2
  exit 1
fi

echo "Install: MAIN_AGENT_ID=$MAIN_AGENT_ID  BOT_NAME=$BOT_NAME"
echo "Scanning $AGENTS_DIR for sub-agent CLAUDE.md files..."
echo

PATCHED=0
SKIPPED=0
NEEDS_PATCH=0

shopt -s nullglob
for agent_path in "$AGENTS_DIR"/*/; do
  agent_name="$(basename "$agent_path")"
  cmd_file="${agent_path}CLAUDE.md"
  [ -f "$cmd_file" ] || { SKIPPED=$((SKIPPED + 1)); continue; }

  # Anchor the search to the stranger-sender block to avoid touching legitimate
  # Marveen mentions elsewhere (e.g. project context). The literal lines we
  # rewrite are exactly the ones emitted by the previous generateClaudeMd.
  if ! grep -qE 'ARANYSZABÁLY|aranyszabaly' "$cmd_file"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Already patched (uses MAIN_AGENT_ID name in the routing line)?
  if grep -qF "\"to\":\"$MAIN_AGENT_ID\"" "$cmd_file"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  NEEDS_PATCH=$((NEEDS_PATCH + 1))
  echo "[needs patch] $agent_name -> $cmd_file"
  if [ "$APPLY" -eq 1 ]; then
    # Only the three load-bearing lines from the ARANYSZABÁLY block are
    # rewritten. We leave any other Marveen mentions intact - those may be
    # references to the canonical project history, not approver routing.
    tmp="$(mktemp)"
    sed \
      -e "s|inter-agent message-t küldeni Marveennek|inter-agent message-t küldeni ${BOT_NAME}-nek|g" \
      -e "s|Példa ping Marveennek:|Példa ping ${BOT_NAME}-nek:|g" \
      -e "s|\"to\":\"marveen\"|\"to\":\"${MAIN_AGENT_ID}\"|g" \
      -e "s|Marveen visszajelzi|${BOT_NAME} visszajelzi|g" \
      "$cmd_file" > "$tmp"
    mv "$tmp" "$cmd_file"
    PATCHED=$((PATCHED + 1))
  fi
done

echo
if [ "$APPLY" -eq 1 ]; then
  echo "Patched: $PATCHED   Skipped (no block or already done): $SKIPPED"
  echo "Sub-agents should pick up the change on their next CLAUDE.md re-read"
  echo "(restart the agent via the dashboard, or wait for the next launchd cycle)."
else
  echo "Would patch: $NEEDS_PATCH   Already-clean or no block: $SKIPPED"
  echo "Re-run with --apply to write changes."
fi
