#!/usr/bin/env bash
# Fleet memory-heartbeat sweep.
# Triggered 4-hourly by the main agent scheduled task `memoria-heartbeat-fleet`.
# Sequentially (staggered) instructs every RUNNING fleet sub-agent to run its own
# memory-heartbeat (memory save + skill reflection). Fleet membership is discovered
# live from /api/agents -- NOT hardcoded. Runs in the background so the main agent's
# turn returns immediately.
#
# Usage: fleet-heartbeat-sweep.sh [stagger_seconds]
set -euo pipefail

ROOT="/Users/jonasgergo/marveen"
TOKEN="$(cat "$ROOT/store/.dashboard-token")"
API="http://localhost:3420"
MAIN_AGENT="${MAIN_AGENT_ID:-marveen}"  # coordinator; excluded from the sweep (has its own heartbeat)
STAGGER="${1:-60}"           # seconds between agents, avoids a fleet-wide token spike
LOG="$ROOT/store/fleet-heartbeat-sweep.log"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# The directive each sub-agent receives. Self-contained: every agent knows its own
# agent_id + domain from its CLAUDE.md/persona. Silent unless something is important.
read -r -d '' DIRECTIVE <<'EOF' || true
[memoria-heartbeat] Ideje a periodikus memoria-heartbeatednek. Vegezd el a sajat agent_id-ddel:
1) Nezd at az elmult idoszak munkadat. Ha volt fontos dontes, preferencia, tanulsag vagy szakmai minta, mentsd el a /api/memories-be (category: hot/warm/cold/shared). Elotte keress ra, ne duplikalj.
2) Skill-reflexio: ha volt 5+ tool-hivasos komplex feladat, hiba->recovery, vagy Jonas-korrekcio, generalj vagy patch-elj skillt (a sajat mappadban), majd index-regen.
3) Ha nincs erdemi uj info, maradj csendben -- ez hatter-karbantartas, NE irj Jonasnak, csak ha tenyleg surgos.
EOF

# Fan-out quota guard. The per-task quota gate sees ONE gate decision, but this sweep
# multiplies it into N sub-agent heartbeat turns (1 decision -> N model calls) that the
# gate cannot account for. Above a fan-out-adjusted threshold, skip the whole sweep so a
# high-quota window is never blown by background heartbeats. Reads the same usage snapshot
# the dashboard maintains (store/claude-usage.json: sessionPct / weeklyPct).
QUOTA_THRESHOLD="${QUOTA_THRESHOLD:-75}"
USAGE_FILE="$ROOT/store/claude-usage.json"
if [ -f "$USAGE_FILE" ]; then
  PCT="$(jq -r '[(.sessionPct // 0), (.weeklyPct // 0)] | max | floor' "$USAGE_FILE" 2>/dev/null || echo 0)"
  if [ -n "$PCT" ] && [ "$PCT" != "null" ] && [ "$PCT" -ge "$QUOTA_THRESHOLD" ] 2>/dev/null; then
    echo "[$(ts)] quota ${PCT}% >= ${QUOTA_THRESHOLD}% (fan-out guard) -- skipping fleet heartbeat sweep" >> "$LOG"
    exit 0
  fi
fi

echo "[$(ts)] fleet-heartbeat sweep start (stagger=${STAGGER}s)" >> "$LOG"

AGENTS="$(curl -s -H "Authorization: Bearer $TOKEN" "$API/api/agents" \
  | jq -r '.[] | select(.running==true) | .name' | grep -vx "$MAIN_AGENT" || true)"

if [ -z "$AGENTS" ]; then
  echo "[$(ts)] no running sub-agents found, nothing to do" >> "$LOG"
  exit 0
fi

COUNT=0
for AGENT in $AGENTS; do
  PAYLOAD="$(jq -nc --arg from "$MAIN_AGENT" --arg to "$AGENT" --arg content "$DIRECTIVE" \
    '{from:$from, to:$to, content:$content}')"
  RESP="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/messages" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$PAYLOAD" || echo "000")"
  echo "[$(ts)]   -> $AGENT : HTTP $RESP" >> "$LOG"
  COUNT=$((COUNT+1))
  sleep "$STAGGER"
done

echo "[$(ts)] fleet-heartbeat sweep done ($COUNT agents triggered)" >> "$LOG"
