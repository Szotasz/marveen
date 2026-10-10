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
# Bands on Linux (usedPct = 100 * (MemTotal - MemAvailable) / MemTotal, from
# /proc/meminfo):
#   usedPct < WARN            -> allow all; clear safe-mode flag
#   WARN <= usedPct < HARD    -> allow ONLY core agents (safe-mode); warn once
#   usedPct >= HARD           -> hard pause: block ALL new spawns; alert once
# Bands on macOS (no /proc/meminfo): the kernel's own memory pressure level
# decides, see read_darwin_pressure below. MARVEEN_MEM_WARN_PCT and
# MARVEEN_MEM_HARD_PCT are Linux-only and have no effect there.
#   level normal (1)          -> ok band
#   level warn (2)            -> safe-mode band (core only)
#   level critical (4)        -> hard band
#   anything else             -> fail-open allow
# Both platforms (on macOS since the pressure-level branch; before it a Mac
# exited fail-open before reaching this rule):
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
    # MEMGATEARG924: `shift 2` with only one argument left is a bash ERROR that
    # shifts NOTHING, so `$#` never reaches 0 and this while-loop spins forever
    # (measured: `--check` as the last argument = infinite loop). The same line
    # also swallowed the NEXT switch: `--check --dry-run` bound ARG="--dry-run"
    # and left DRY_RUN=0, so a run meant to be side-effect free wrote the
    # safe-mode flag and attempted a Telegram alert. Take an agent name only if
    # it is really there and is not itself a switch; the empty-agent case is
    # already handled fail-open below ("--check needs an agent name").
    --check)
      MODE="check"
      if [[ $# -ge 2 && "$2" != --* ]]; then ARG="$2"; shift 2; else shift; fi
      ;;
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

# Percent thresholds: Linux only. On macOS the band comes from the kernel's
# memory pressure level instead (see read_darwin_pressure).
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
# #915: main channel state is install-scoped once migrated; the legacy shared
# path only serves unmigrated installs.
TG_CHAN_DIR="${TELEGRAM_STATE_DIR:-}"
if [ -z "$TG_CHAN_DIR" ]; then
  TG_CHAN_DIR="$INSTALL_DIR/.claude/channels/telegram"
  [ -f "$TG_CHAN_DIR/.env" ] || TG_CHAN_DIR="$HOME/.claude/channels/telegram"
fi
ENV_FILE="${TELEGRAM_ENV:-$TG_CHAN_DIR/.env}"
# Alert target: the owner's chat id. Resolve from the channel access.json (the
# first allow-listed sender) so no chat-id is ever hardcoded; override with
# MARVEEN_ALERT_CHAT_ID. Empty -> the Telegram alert is skipped (log only), never
# sent to a stranger.
ACCESS_JSON="${TELEGRAM_ACCESS:-$TG_CHAN_DIR/access.json}"
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"
if [[ -z "$CHAT_ID" && -f "$ACCESS_JSON" ]] && command -v python3 >/dev/null 2>&1; then
  CHAT_ID="$(python3 -c 'import json,sys
try:
  a=json.load(open(sys.argv[1]));v=a.get("allowFrom") or []
  print(v[0] if v else "")
except Exception: print("")' "$ACCESS_JSON" 2>/dev/null)"
fi
# NULLAORFLEET921: the "0" installer placeholder is not a chat (install-linux.sh:812).
# The two notifiers got this guard in #1450 and this file did not, so the three
# surfaces diverged. MEASURED before adding it, and the honest state is worth
# writing down: today NO path puts a "0" here. Nothing in the repo sets
# MARVEEN_ALERT_CHAT_ID (no unit, no plist, no installer line), the placeholder
# lands in ALLOWED_CHAT_ID which this script never reads, and no shipped installer
# version ever seeded access.json's allowFrom from CHAT_ID (107 historical versions
# checked, 0 hits, positive control passed). This line is therefore defence in
# depth, not a live bug fix: it matters the moment someone populates the alert
# chat id from the install config -- which is exactly what the external ticket
# suggests doing for the notifiers.
# Without it the value is NOT silent but noisy-useless: measured, "0" takes the
# same path as a real id, so the send is attempted, fails, and is retried every
# run because a failed send deliberately never stamps the cooldown.
[ "$CHAT_ID" = "0" ] && CHAT_ID=""
ALERT_COOLDOWN=600   # seconds; do not repeat the same band's alert within this

log() { echo "[fleet-memory-gate] $*" >&2; }

# --- read memory ---
# MEMGATE_PROC_MEMINFO exists for tests only (no /proc to stub on macOS).
PROC_MEMINFO="${MEMGATE_PROC_MEMINFO:-/proc/meminfo}"
mem_total="$(awk '/^MemTotal:/{print $2}' "$PROC_MEMINFO" 2>/dev/null)"
mem_avail="$(awk '/^MemAvailable:/{print $2}' "$PROC_MEMINFO" 2>/dev/null)"

# macOS has no /proc/meminfo, so without this block the gate took the fail-open
# branch below on every Mac and never gated anything.
#
# On macOS the BAND comes from the kernel's own memory pressure level, not from
# a used-percent figure. A percent model does not transfer: wired memory and
# the compressor dominate there and are not an OOM signal. Measured on a
# healthy 24 GiB Apple Silicon Mac (macOS 26): about 15.5 GiB wired, so the
# vm_stat reading below said 90-91% used (the default hard band) while the
# kernel said pressure level 1 (normal) and memory_pressure -Q about 26% free.
#
# kern.memorystatus_vm_pressure_level values: 1 = normal, 2 = warn,
# 4 = critical. Source checked locally: /usr/bin/memory_pressure reads this
# sysctl (the name is in its strings), and the values match
# DISPATCH_MEMORYPRESSURE_NORMAL 0x01 / _WARN 0x02 / _CRITICAL 0x04 in the
# macOS SDK header usr/include/dispatch/source.h. No public header in the SDK
# states that the sysctl reports exactly these dispatch values; that mapping
# is taken from the matching numbers plus a live reading of 1 under normal
# pressure. Any other value (or none) is treated as unreadable -> fail-open.
# MEMGATE_DARWIN_PRESSURE (the level value) exists for tests only.
read_darwin_pressure() {
  local raw
  if [[ -n "${MEMGATE_DARWIN_PRESSURE+x}" ]]; then
    raw="$MEMGATE_DARWIN_PRESSURE"
  else
    raw="$(/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
  fi
  pressure_raw="$(printf '%s' "$raw" | tr -d '[:space:]' | cut -c1-32)"
  case "$pressure_raw" in
    1) pressure_level=1; pressure_name="normal" ;;
    2) pressure_level=2; pressure_name="warn" ;;
    4) pressure_level=4; pressure_name="critical" ;;
    *) return 1 ;;
  esac
  return 0
}

# INFORMATIONAL on macOS (status text and alert only, never the band):
#   MemTotal     = sysctl hw.memsize / 1024
#   MemAvailable = (Pages free + File-backed pages + Pages purgeable)
#                  * page size / 1024        (all from vm_stat)
# Free pages plus clean file cache and purgeable pages is the closest match to
# Linux MemAvailable; wired, compressor and anonymous pages count as used.
# Speculative pages are not added: they are already inside "File-backed
# pages" (measured: file-backed + anonymous = active + inactive + speculative).
# Absolute tool paths: sysctl lives in /usr/sbin, which a minimal service PATH
# may not contain. MEMGATE_UNAME / MEMGATE_DARWIN_VMSTAT (a file holding vm_stat
# output) / MEMGATE_DARWIN_MEMSIZE (bytes) exist for tests only, so the Darwin
# branch can be exercised on any host.
read_darwin_mem() {
  local vmstat_out memsize avail_kb
  if [[ -n "${MEMGATE_DARWIN_VMSTAT:-}" ]]; then
    vmstat_out="$(cat "$MEMGATE_DARWIN_VMSTAT" 2>/dev/null)"
  else
    vmstat_out="$(/usr/bin/vm_stat 2>/dev/null)"
  fi
  if [[ -n "${MEMGATE_DARWIN_MEMSIZE:-}" ]]; then
    memsize="$MEMGATE_DARWIN_MEMSIZE"
  else
    memsize="$(/usr/sbin/sysctl -n hw.memsize 2>/dev/null)"
  fi
  [[ "$memsize" =~ ^[0-9]+$ ]] || return 1
  avail_kb="$(printf '%s\n' "$vmstat_out" | awk '
    /page size of [0-9]+ bytes/ {
      for (i = 1; i < NF; i++) if ($i == "of") ps = $(i + 1) + 0
    }
    /^Pages free:/        { v = $NF; gsub(/[^0-9]/, "", v); if (v != "") { free = v + 0; nf = 1 } }
    /^File-backed pages:/ { v = $NF; gsub(/[^0-9]/, "", v); if (v != "") { file = v + 0; nb = 1 } }
    /^Pages purgeable:/   { v = $NF; gsub(/[^0-9]/, "", v); if (v != "") { purg = v + 0; np = 1 } }
    END {
      if (!nf || !nb || !np || ps <= 0) exit 1
      printf "%.0f\n", (free + file + purg) * ps / 1024
    }' 2>/dev/null)" || return 1
  [[ "$avail_kb" =~ ^[0-9]+$ ]] || return 1
  local total_kb=$(( memsize / 1024 ))
  (( total_kb > 0 && avail_kb <= total_kb )) || return 1
  mem_total="$total_kb"
  mem_avail="$avail_kb"
  return 0
}

SIGNAL="meminfo"
if [[ -z "${mem_total:-}" || -z "${mem_avail:-}" ]] \
   && [[ "${MEMGATE_UNAME:-$(uname -s 2>/dev/null)}" == "Darwin" ]]; then
  SIGNAL="pressure"
  pressure_level=""; pressure_name=""; pressure_raw=""
  if ! read_darwin_pressure; then
    log "cannot read macOS memory pressure level (kern.memorystatus_vm_pressure_level='${pressure_raw}') -- fail-open (allow)"
    echo "pressure-unreadable: allow"
    exit 0
  fi
  mem_total=""; mem_avail=""
  if read_darwin_mem; then
    used_txt="$(( (mem_total - mem_avail) * 100 / mem_total ))%"
    avail_txt="$(( mem_avail / 1024 ))MB"
  else
    log "vm_stat / sysctl hw.memsize unreadable -- numbers unknown; band still from the pressure level"
    used_txt="unknown"; avail_txt="unknown"
  fi
fi
if [[ "$SIGNAL" == "meminfo" ]]; then
  if [[ -z "${mem_total:-}" || -z "${mem_avail:-}" || "$mem_total" -le 0 ]]; then
    log "cannot read /proc/meminfo -- fail-open (allow)"
    echo "meminfo-unreadable: allow"
    exit 0
  fi
  used_pct=$(( (mem_total - mem_avail) * 100 / mem_total ))
  avail_mb=$(( mem_avail / 1024 ))
fi

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
    # Honest send + cooldown stamp ONLY on confirmed delivery
    # (NOTIFYVAKSWEEP826): stamping a failed send suppressed the retry for
    # ALERT_COOLDOWN while the fleet was heading into OOM.
    . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/send-telegram.sh"
    local send_err
    if send_err="$(send_telegram_message "$token" "$CHAT_ID" "$msg" 2>&1)"; then
      log "Telegram sent [$band]"
      echo "${band}:${now}" >"$ALERT_STAMP" 2>/dev/null || true
    else
      log "Telegram send FAILED -- cooldown stamp NOT written, will retry next run: ${send_err}"
    fi
  else
    log "no TELEGRAM_BOT_TOKEN; alert only logged"
  fi
}

set_safe_mode() {
  (( DRY_RUN )) && return 0
  (( OBSERVE )) && return 0   # observe-only: never persist the safe-mode marker
  [[ -f "$SAFE_FLAG" ]] || echo "$(date '+%Y-%m-%d %H:%M:%S') ${mem_summary}" >"$SAFE_FLAG" 2>/dev/null || true
}
clear_safe_mode() {
  (( DRY_RUN )) && return 0
  [[ -f "$SAFE_FLAG" ]] && rm -f "$SAFE_FLAG" 2>/dev/null || true
}

# --- determine band + side effects ---
band="ok"
if [[ "$SIGNAL" == "pressure" ]]; then
  # macOS: the kernel pressure level decides; used/avail are informational.
  mem_summary="pressure=${pressure_name}(${pressure_level}) used=${used_txt} avail=${avail_txt}"
  case "$pressure_level" in
    4) band="hard" ;;
    2) band="warn" ;;
  esac
  info_txt="Tájékoztató adat (nem ez dönt macOS-en): vm_stat szerint használt ${used_txt}, elérhető ${avail_txt}."
  if [[ "$band" == "hard" ]]; then
    set_safe_mode
    send_alert hard "Marveen memória-kapu: HARD PAUSE. A macOS kernel memórianyomás-szintje kritikus (kern.memorystatus_vm_pressure_level=${pressure_level}). ${info_txt} Új agent-indítás LEÁLLÍTVA (futók érintetlenek). Nézd a párhuzamos agent-számot."
  elif [[ "$band" == "warn" ]]; then
    set_safe_mode
    send_alert warn "Marveen memória-kapu: SAFE-MODE. A macOS kernel memórianyomás-szintje figyelmeztető (kern.memorystatus_vm_pressure_level=${pressure_level}). ${info_txt} Csak core agentek indulhatnak, a többi indítás visszafogva."
  else
    clear_safe_mode
  fi
  status_line="pressure=${pressure_name}(${pressure_level}) used=${used_txt}(info) avail=${avail_txt}(info) running_agents=${running} cap=${AGENT_CAP} band=${band} signal=kernel-pressure"
else
  mem_summary="used=${used_pct}% avail=${avail_mb}MB"
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
  # Linux line kept byte-identical to before; no "signal=" field means the
  # /proc/meminfo percent bands decided.
  status_line="used=${used_pct}% avail=${avail_mb}MB running_agents=${running} cap=${AGENT_CAP} band=${band}"
fi

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
