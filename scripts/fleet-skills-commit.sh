#!/usr/bin/env bash
# fleet-skills-commit.sh -- commit all fleet skill repositories in one step.
#
# Usage:
#   ./scripts/fleet-skills-commit.sh status           -- show dirty/missing repos
#   ./scripts/fleet-skills-commit.sh commit "message" -- commit all changes
#
# Rule: run with "status" before any bulk skill operation to confirm
# a clean baseline. Run with "commit" after to record the result.
#
# New agents: the agents/ directory is scanned dynamically -- new agents with
# a .claude/skills/ directory are picked up automatically without editing this
# script.

set -euo pipefail

BASE="$(cd "$(dirname "$0")/.." && pwd)"
GLOBAL_SKILLS="$HOME/.claude/skills"

# Build the list: global first, then project-level, then per-agent (dynamic).
SKILL_DIRS=()
SKILL_DIRS+=("$GLOBAL_SKILLS")
SKILL_DIRS+=("$BASE/.claude/skills")
for agent_dir in "$BASE"/agents/*/; do
  skill_dir="${agent_dir}.claude/skills"
  [ -d "$skill_dir" ] && SKILL_DIRS+=("$skill_dir")
done

MODE="${1:-status}"
COMMIT_MSG="${2:-}"

if [[ "$MODE" != "status" && "$MODE" != "commit" ]]; then
  echo "Usage: $0 status | commit <message>" >&2
  exit 1
fi

if [[ "$MODE" == "commit" && -z "$COMMIT_MSG" ]]; then
  echo "Error: commit message required" >&2
  exit 1
fi

ERRORS=0
DIRTY=0

for dir in "${SKILL_DIRS[@]}"; do
  # Display relative to BASE when inside it, otherwise relative to HOME.
  if [[ "$dir" == "$BASE/"* ]]; then
    label="marveen/${dir#"$BASE/"}"
  else
    label="~/${dir#"$HOME/"}"
  fi

  if [ ! -d "$dir" ]; then
    echo "SKIP (no dir): $label"
    continue
  fi

  if [ ! -d "$dir/.git" ]; then
    echo "MISSING REPO: $label -- run git init before bulk operations" >&2
    ERRORS=$((ERRORS + 1))
    continue
  fi

  if [[ "$MODE" == "status" ]]; then
    changes=$(git -C "$dir" status --porcelain 2>/dev/null)
    if [ -n "$changes" ]; then
      echo "DIRTY: $label"
      git -C "$dir" status --short
      DIRTY=$((DIRTY + 1))
    else
      last=$(git -C "$dir" log --oneline -1 2>/dev/null || echo "(no commits)")
      echo "clean: $label  [$last]"
    fi
  else
    changes=$(git -C "$dir" status --porcelain 2>/dev/null)
    if [ -n "$changes" ]; then
      git -C "$dir" add -A
      git -C "$dir" commit -q -m "$COMMIT_MSG"
      echo "committed: $label  [$(git -C "$dir" log --oneline -1)]"
    else
      echo "no changes: $label"
    fi
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "ERROR: $ERRORS repo(s) missing .git -- initialize before continuing." >&2
  exit 2
fi

if [[ "$MODE" == "status" && "$DIRTY" -gt 0 ]]; then
  echo ""
  echo "WARNING: $DIRTY repo(s) have uncommitted changes."
  exit 1
fi
