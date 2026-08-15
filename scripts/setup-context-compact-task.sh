#!/usr/bin/env bash
# setup-context-compact-task.sh
# Idempotently creates or updates the scheduled task files that register the
# context-compact-monitor heartbeat in the Claude Code task runner.
#
# Run once after cloning or moving the repository. The schedule runner picks
# up changes automatically within 60 seconds; no restart required.
#
# Created task: ~/.claude/scheduled-tasks/context-compact-monitor/
#   SKILL.md        -- prompt sent to the main agent every 15 minutes
#   task-config.json -- schedule, type, and per-install agent config
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${MARVEEN_ROOT:-$(dirname "$SCRIPT_DIR")}"
TASK_DIR="${HOME}/.claude/scheduled-tasks/context-compact-monitor"
SKILL_FILE="${TASK_DIR}/SKILL.md"
CONFIG_FILE="${TASK_DIR}/task-config.json"
MONITOR_SCRIPT="${REPO_ROOT}/scripts/context-compact-monitor.sh"
ENV_FILE="${REPO_ROOT}/.env"

# Read MAIN_AGENT_ID from the repo .env; fall back to the upstream default.
read_main_agent_id() {
    if [ -f "$ENV_FILE" ]; then
        grep '^MAIN_AGENT_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- | sed "s/[\"']//g" | tr -d ' \r'
    fi
}
AGENT_ID="$(read_main_agent_id)"
AGENT_ID="${AGENT_ID:-marveen}"

mkdir -p "$TASK_DIR"

# SKILL.md -- always rewrite so the path stays current after repo moves.
cat > "$SKILL_FILE" << SKILLEOF
---
name: context-compact-monitor
description: Automatikus /compact kuldese ha agenst kontextus >= 75% (15 percenkent)
---

[context-compact-monitor heartbeat] Futtasd le a kontextus-compact monitort:
bash ${MONITOR_SCRIPT}
Ha volt compact esemeny, a script automatikusan naplozza. Ha nem volt semmi, nincs szukseges ertesites.
SKILLEOF

# task-config.json -- idempotent: preserve createdAt if the file already exists.
CREATED_AT="$(CONFIG_FILE="$CONFIG_FILE" python3 << 'PYEOF'
import json, os, sys
path = os.environ.get("CONFIG_FILE", "")
try:
    print(json.load(open(path)).get("createdAt", 0))
except Exception:
    print(0)
PYEOF
)"

AGENT_ID="$AGENT_ID" CREATED_AT="$CREATED_AT" python3 << 'PYEOF' > "$CONFIG_FILE"
import json, os, sys
cfg = {
    "schedule": "*/15 * * * *",
    "agent": os.environ["AGENT_ID"],
    "enabled": True,
    "type": "heartbeat",
    "skipIfBusy": True,
    "forceSend": False,
    "description": "Automatikus /compact kuldese ha agenst kontextus >= 75% (15 percenkent)",
    "createdAt": int(os.environ.get("CREATED_AT", "0"))
}
json.dump(cfg, sys.stdout, indent=2)
print()
PYEOF

echo "context-compact-monitor task configured"
echo "  SKILL.md        : ${SKILL_FILE}"
echo "  task-config.json: agent=${AGENT_ID}, schedule=*/15 * * * *, type=heartbeat"
echo "  monitor script  : ${MONITOR_SCRIPT}"
[ -x "$MONITOR_SCRIPT" ] || echo "  WARNING: monitor script not found or not executable: ${MONITOR_SCRIPT}"
