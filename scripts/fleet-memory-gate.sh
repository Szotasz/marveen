#!/usr/bin/env bash
# fleet-memory-gate.sh  --check <agent> | --verdict | --status  [--dry-run]
#
# Commit 3 v1 -- SAFE-MODE / MEMORY GATE (decision logic, single source of truth).
#
# The Marveen fleet auto-respawns on every user-manager (re)init: the dashboard's
# channel-monitor reconcile loop starts every desired-but-down agent ~15s apart.
# On a 7.4 GiB WSL VM that startup storm drove app.slice to a 6.9G peak and an OOM
# poweroff (2026-07-09). This gate decides, per agent, whether a NEW start is
# allowed given current MemAvailable + running-agent count. It NEVER kills or
# restarts anything -- it only answers "may this agent start now?" and (as a side
# effect) manages the safe-mode flag + a deduped Telegram alert.
#
# Contract (exit codes):
#   0   -> ALLOW this start
#   10  -> BLOCK this start (memory/cap; non-core in safe-mode band, or hard pause)
#   (any internal error -> exit 0 / ALLOW: fail-open, so a broken gate can never
#    freeze the fleet -- worst case is the pre-Commit-3 behaviour.)
#
# Bands (usedPct = 100 * (MemTotal - MemAvailable) / MemTotal):
#   usedPct < WARN            -> allow all; clear safe-mode flag
#   WARN <= usedPct < HARD    -> allow ONLY core agents (safe-mode); warn once
#   usedPct >= HARD           -> hard pause: block ALL new spawns; alert once
#   running non-core >= CAP   -> block non-core regardless of band
#
# Kill-switch: MARVEEN_MEM_GATE_DISABLE=1 -> immediate exit 0 (pure pass-through).
#
# Read-only except its own state files (safe-mode flag + alert-dedupe stamp);
# Telegram send is best-effort; --dry-run makes it fully side-effect free.

set -uo pipefail

MODE=""; ARG=""; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   MODE="check"; ARG="${2:-}"; shift 2 ;;
    --verdict) MODE="verdict"; shift ;;
    --status)  MODE="status"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) shift ;;
  esac
done
[[ -z "$MODE" ]] && MODE="verdict"

# Kill-switch: pure pass-through, no reads, no side effects.
if [[ "${MARVEEN_MEM_GATE_DISABLE:-0}" == "1" ]]; then
  echo "gate-disabled: allow (MARVEEN_MEM_GATE_DISABLE=1)"
  exit 0
fi

# Resolve this install's own dir + main agent id from its .env (no hardcoded
# owner/agent/chat-id -- distribution rule). SERVICE_ID falls back to
# MAIN_AGENT_ID which falls back to "marveen"; the main agent MUST be core so
# a memory-pressure band never throttles the operator's primary bot.
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_env_val() { [[ -f "$INSTALL_DIR/.env" ]] && grep -E "^$1=" "$INSTALL_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
MAIN_AGENT_ID="$(_env_val MAIN_AGENT_ID)"; MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"

WARN_PCT="${MARVEEN_MEM_WARN_PCT:-80}"
HARD_PCT="${MARVEEN_MEM_HARD_PCT:-90}"
AGENT_CAP="${MARVEEN_AGENT_CAP:-12}"
# Core = never-throttled agents. Defaults to THIS install's main agent so the
# primary bot always survives the safe-mode band; override with MARVEEN_CORE_AGENTS.
CORE_AGENTS="${MARVEEN_CORE_AGENTS:-$MAIN_AGENT_ID}"
STAGGER_SEC="${MARVEEN_STAGGER_SEC:-20}"   # consumed by fleet-safe-start.sh
STATE_DIR="${MARVEEN_STORE:-$INSTALL_DIR/store}"
SAFE_FLAG="$STATE_DIR/.fleet-safe-mode"
ALERT_STAMP="$STATE_DIR/.fleet-memgate-alert"   # "band:epoch" of last alert
OBSERVE_FLAG="$STATE_DIR/.fleet-memgate-observe"  # if present -> observe-only

# OBSERVE-ONLY mode (Istvan standing directive 2026-07-09, re-confirmed 2026-07-15):
# monitor + alert stay ON, but the gate NEVER blocks a start and NEVER writes the
# safe-mode marker -- Istvan makes the throttle/rollback call himself. Toggle via the
# file flag (touch/rm store/.fleet-memgate-observe) or MARVEEN_MEM_GATE_OBSERVE=1.
OBSERVE=0
if [[ "${MARVEEN_MEM_GATE_OBSERVE:-0}" == "1" || -f "$OBSERVE_FLAG" ]]; then OBSERVE=1; fi
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
# Alert target: the owner's chat id. Resolve from the channel access.json (the
# first allow-listed sender) so no chat-id is ever hardcoded; override with
# MARVEEN_ALERT_CHAT_ID. Empty -> the Telegram alert is skipped (log only), never
# sent to a stranger.
ACCESS_JSON="${TELEGRAM_ACCESS:-$HOME/.claude/channels/telegram/access.json}"
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"
if [[ -z "$CHAT_ID" && -f "$ACCESS_JSON" ]] && command -v python3 >/dev/null 2>&1; then
  CHAT_ID="$(python3 -c 'import json,sys
try:
  a=json.load(open(sys.argv[1]));v=a.get("allowFrom") or []
  print(v[0] if v else "")
except Exception: print("")' "$ACCESS_JSON" 2>/dev/null)"
fi
ALERT_COOLDOWN=600   # seconds; do not repeat the same band's alert within this

log() { echo "[fleet-memory-gate] $*" >&2; }

# --- read memory ---
mem_total="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"
mem_avail="$(awk '/^MemAvailable:/{print $2}' /proc/meminfo 2>/dev/null)"
if [[ -z "${mem_total:-}" || -z "${mem_avail:-}" || "$mem_total" -le 0 ]]; then
  log "cannot read /proc/meminfo -- fail-open (allow)"
  echo "meminfo-unreadable: allow"
  exit 0
fi
used_pct=$(( (mem_total - mem_avail) * 100 / mem_total ))
avail_mb=$(( mem_avail / 1024 ))

# --- count running non-core agents (tmux agent-* sessions; dependency-free) ---
running=0
if command -v tmux >/dev/null 2>&1; then
  running="$(tmux ls 2>/dev/null | grep -c '^agent-' || echo 0)"
fi

is_core() {
  local a="$1"; local c
  IFS=',' read -ra _cores <<< "$CORE_AGENTS"
  for c in "${_cores[@]}"; do [[ "$a" == "$(echo "$c" | tr -d ' ')" ]] && return 0; done
  return 1
}

# Best-effort deduped Telegram alert (band-cooldown).
send_alert() {
  local band="$1" msg="$2"
  (( DRY_RUN )) && { log "DRY-RUN alert [$band]: $msg"; return 0; }
  # No resolvable owner chat id -> never send (would otherwise go nowhere or, with
  # a hardcoded default, to a stranger). Log and move on.
  [[ -z "$CHAT_ID" ]] && { log "no owner chat id resolved; skipping Telegram alert [$band]"; return 0; }
  local now prev_band prev_ep
  now="$(date +%s)"
  if [[ -f "$ALERT_STAMP" ]]; then
    prev_band="$(cut -d: -f1 "$ALERT_STAMP" 2>/dev/null)"
    prev_ep="$(cut -d: -f2 "$ALERT_STAMP" 2>/dev/null | tr -dc '0-9')"
    if [[ "$prev_band" == "$band" && -n "${prev_ep:-}" ]] && (( now - prev_ep < ALERT_COOLDOWN )); then
      log "alert [$band] within cooldown; skipping"; return 0
    fi
  fi
  local token=""
  [[ -f "$ENV_FILE" ]] && token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
  if [[ -n "$token" ]]; then
    curl -s --max-time 15 "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" --data-urlencode "text=${msg}" >/dev/null 2>&1 \
      && log "Telegram sent [$band]" || log "Telegram send failed (best-effort)"
  else
    log "no TELEGRAM_BOT_TOKEN; alert only logged"
  fi
  echo "${band}:${now}" >"$ALERT_STAMP" 2>/dev/null || true
}

set_safe_mode() {
  (( DRY_RUN )) && return 0
  (( OBSERVE )) && return 0   # observe-only: never persist the safe-mode marker
  [[ -f "$SAFE_FLAG" ]] || echo "$(date '+%Y-%m-%d %H:%M:%S') used=${used_pct}% avail=${avail_mb}MB" >"$SAFE_FLAG" 2>/dev/null || true
}
clear_safe_mode() {
  (( DRY_RUN )) && return 0
  [[ -f "$SAFE_FLAG" ]] && rm -f "$SAFE_FLAG" 2>/dev/null || true
}

# --- determine band + side effects ---
band="ok"
if (( used_pct >= HARD_PCT )); then
  band="hard"
  set_safe_mode
  send_alert hard "Marveen memória-kapu: HARD PAUSE. Használt memória ${used_pct}% (elérhető ${avail_mb} MB), a ${HARD_PCT}% küszöb felett. Új agent-indítás LEÁLLÍTVA (futók érintetlenek). Nézd a párhuzamos agent-számot."
elif (( used_pct >= WARN_PCT )); then
  band="warn"
  set_safe_mode
  send_alert warn "Marveen memória-kapu: SAFE-MODE. Használt memória ${used_pct}% (elérhető ${avail_mb} MB), a ${WARN_PCT}% küszöb felett. Csak core agentek indulhatnak, a többi indítás visszafogva."
else
  clear_safe_mode
fi

status_line="used=${used_pct}% avail=${avail_mb}MB running_agents=${running} cap=${AGENT_CAP} band=${band}"

# Observe-only: alerts have already fired above; from here the gate only reports and
# always ALLOWS -- no block exit (10), no cap-block. Istvan owns the throttle call.
if (( OBSERVE )); then
  echo "observe-only (monitor+alert, no block): $status_line"
  exit 0
fi

case "$MODE" in
  status|verdict)
    echo "$status_line"
    # verdict exit: 0 if a generic non-core start would be allowed, else 10
    if [[ "$band" == "hard" ]]; then exit 10; fi
    if [[ "$band" == "warn" ]]; then exit 10; fi
    if (( running >= AGENT_CAP )); then exit 10; fi
    exit 0
    ;;
  check)
    agent="$ARG"
    if [[ -z "$agent" ]]; then log "--check needs an agent name"; echo "no-agent: allow"; exit 0; fi
    if is_core "$agent"; then
      # Core agents (dashboard/channels are services, not gated) may start except
      # in a genuine hard pause.
      if [[ "$band" == "hard" ]]; then
        echo "block core (hard pause): $agent | $status_line"; exit 10
      fi
      echo "allow core: $agent | $status_line"; exit 0
    fi
    # non-core
    if [[ "$band" == "hard" || "$band" == "warn" ]]; then
      echo "block non-core (${band}): $agent | $status_line"; exit 10
    fi
    if (( running >= AGENT_CAP )); then
      send_alert cap "Marveen memória-kapu: agent-cap elérve (${running}/${AGENT_CAP}). Új nem-core agent-indítás visszafogva, amíg csökken a szám."
      echo "block non-core (cap ${running}/${AGENT_CAP}): $agent | $status_line"; exit 10
    fi
    echo "allow: $agent | $status_line"; exit 0
    ;;
esac
exit 0
