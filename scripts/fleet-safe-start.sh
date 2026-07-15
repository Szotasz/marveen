#!/usr/bin/env bash
# fleet-safe-start.sh  [--dry-run] [--fresh]
#
# Commit 3 v1 -- MANUAL operator tool to bring the fleet up SAFELY, honoring the
# memory gate. NOT wired into boot (per Istvan: "Commit 3 utan se inditsd
# automatikusan a teljes flottat"). Use this instead of starting every agent at
# once after a restart.
#
# Order: core agents first (this install's main agent by default), then the rest one-by-one with
# a stagger, calling fleet-memory-gate.sh --check before EACH start. When the gate
# says BLOCK (safe-mode band / hard pause / cap), that agent is skipped and the
# script stops adding non-core agents -- dashboard + channels (systemd services)
# are never touched. Existing running agents are left alone; nothing is killed.
#
# Reads the desired/known agents from the dashboard /api/agents. Requires the
# dashboard to be up (it is a systemd service and always is). --dry-run prints the
# plan without starting anything. --fresh passes {"fresh":true} to the start API.

set -uo pipefail

DRY_RUN=0; FRESH=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --fresh)   FRESH=1 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/fleet-memory-gate.sh"
# Resolve this install's main agent id from its .env (no hardcoded agent names --
# distribution rule); mirrors fleet-memory-gate.sh so the same agent is "core".
INSTALL_DIR="$(cd "$HERE/.." && pwd)"
_env_val() { [[ -f "$INSTALL_DIR/.env" ]] && grep -E "^$1=" "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
MAIN_AGENT_ID="$(_env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
STORE="${MARVEEN_STORE:-$HOME/marveen/store}"
TOKEN_FILE="$STORE/.dashboard-token"
DASH="${MARVEEN_DASHBOARD_URL:-http://localhost:3420}"
# Core = started first / never throttled. Defaults to THIS install's main agent
# so the primary bot always comes up; override with MARVEEN_CORE_AGENTS.
CORE_AGENTS="${MARVEEN_CORE_AGENTS:-$MAIN_AGENT_ID}"
STAGGER_SEC="${MARVEEN_STAGGER_SEC:-20}"

log() { echo "[fleet-safe-start] $*"; }

[[ -x "$GATE" ]] || { log "gate script not found/executable: $GATE"; exit 1; }
[[ -f "$TOKEN_FILE" ]] || { log "no dashboard token at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

# Fetch agents (name + running) from the dashboard.
agents_json="$(curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$DASH/api/agents" 2>/dev/null)"
[[ -z "$agents_json" ]] && { log "could not reach $DASH/api/agents"; exit 1; }

# Emit "name running" lines. running is true/false.
mapfile -t rows < <(printf '%s' "$agents_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
a=d if isinstance(d,list) else d.get('agents',[])
for x in a:
    name=x.get('id') or x.get('name')
    run=x.get('running')
    if run is None: run = x.get('status')=='running'
    if name: print(name, 'true' if run else 'false')
" 2>/dev/null)

[[ ${#rows[@]} -eq 0 ]] && { log "no agents parsed from /api/agents"; exit 1; }

is_core() {
  local a="$1" c
  IFS=',' read -ra cs <<< "$CORE_AGENTS"
  for c in "${cs[@]}"; do [[ "$a" == "$(echo "$c" | tr -d ' ')" ]] && return 0; done
  return 1
}

start_one() {
  local name="$1"
  if (( DRY_RUN )); then
    "$GATE" --check "$name" --dry-run >/dev/null 2>&1 && { log "DRY-RUN would start: $name"; return 0; } || { log "DRY-RUN gate BLOCKS: $name"; return 1; }
  fi
  if ! "$GATE" --check "$name" >/dev/null 2>&1; then
    log "gate BLOCKS $name (memory/cap) -- skipping"; return 1
  fi
  local body='{}'; (( FRESH )) && body='{"fresh":true}'
  local ok
  ok="$(curl -s --max-time 30 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d "$body" "$DASH/api/agents/$name/start" 2>/dev/null)"
  if printf '%s' "$ok" | grep -q '"ok":true'; then
    log "started: $name"; return 0
  fi
  log "start failed for $name: $ok"; return 1
}

# 1) core first
for row in "${rows[@]}"; do
  name="${row%% *}"; run="${row##* }"
  is_core "$name" || continue
  [[ "$run" == "true" ]] && { log "core already running: $name"; continue; }
  start_one "$name"
  (( DRY_RUN )) || sleep "$STAGGER_SEC"
done

# 2) non-core, staggered, stop adding once the gate blocks (memory pressure rising)
blocked=0
for row in "${rows[@]}"; do
  name="${row%% *}"; run="${row##* }"
  is_core "$name" && continue
  [[ "$run" == "true" ]] && continue
  if ! start_one "$name"; then
    blocked=$((blocked+1))
    # After the gate starts blocking, further non-core starts will also block;
    # stop hammering the API and let the operator re-run when memory frees up.
    log "gate closed after ${name}; halting non-core bring-up (re-run when MemAvailable recovers)."
    break
  fi
  (( DRY_RUN )) || sleep "$STAGGER_SEC"
done

log "done. $( "$GATE" --status 2>/dev/null | tail -1 )"
