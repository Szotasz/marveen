#!/bin/bash
# Marveen Memory Auto-Save Hook
# Runs before context compaction to extract and save important information
# Called by Claude Code PreCompact hook (agent type handles the AI extraction)

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Load config (so WEB_PORT from .env is available before API is built)
. "$INSTALL_DIR/scripts/lib/load-env.sh"
load_env_file "$INSTALL_DIR/.env"

API="http://localhost:${WEB_PORT:-3420}/api"

AGENT_ID="${1:-marveen}"
CONTENT="$2"

if [ -z "$CONTENT" ]; then
  exit 0
fi

# Save to memory API
curl -s -X POST "$API/memories" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"content\": $(echo "$CONTENT" | python3 -I -S -c 'import json,sys; print(json.dumps(sys.stdin.read()))'), \"tier\": \"warm\", \"keywords\": \"auto-save, compaction\"}" > /dev/null 2>&1

# Also append to daily log
curl -s -X POST "$API/daily-log" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\": \"$AGENT_ID\", \"content\": $(echo "## $(date +%H:%M) -- Auto-save (compaction)\n$CONTENT" | python3 -I -S -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" > /dev/null 2>&1

exit 0
