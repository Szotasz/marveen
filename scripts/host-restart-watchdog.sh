#!/usr/bin/env bash
# host-restart-watchdog.sh
#
# Fires once at every user-manager start (oneshot, WantedBy=default.target).
# Under WSL2 the whole utility VM can shut down and re-boot (vmIdleTimeout
# auto-shutdown, Windows sleep/resume, `wsl --shutdown`), which tears down the
# kernel + system/user systemd + tmux + dashboard + channels all at once and is
# NOT an application crash. This watchdog detects that host/VM restart via the
# kernel boot time (/proc/stat btime) and sends ONE Telegram notice that names
# it as a host/WSL-VM restart (with an estimated downtime), so a fleet-wide
# silence is never mistaken for a CostOps/app crash.
#
# App/service crashes do NOT change btime and never trigger this script -- they
# are reported separately by the OnFailure= drop-ins (marveen-notify@.service).
# That split is the whole point: btime-change => host restart; OnFailure => app.
#
# Safe by construction: read-only except for the state file; Telegram send is
# best-effort; the script always exits 0 so the oneshot unit never enters
# `failed` (a failing watchdog would itself look like an incident).

set -uo pipefail

STATE_DIR="${MARVEEN_STORE:-$HOME/marveen/store}"
STATE_FILE="$STATE_DIR/.last-btime"
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
# Alert target chat-id -- MUST come from the install's own config; there is
# deliberately NO hardcoded fallback (a hardcoded id would make every downstream
# install send its host-stability alerts to that one private chat).
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"

log() { echo "[host-restart-watchdog] $*"; }

# Real WSL check -- only under WSL is a whole-VM reboot the expected surprise;
# on a bare-metal/other Linux host a btime change is an ordinary reboot, so we
# word the alert accordingly instead of always claiming "WSL VM restarted".
if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null \
   || [[ -n "${WSL_DISTRO_NAME:-}" ]] || [[ -e /run/WSL ]]; then
  HOST_KIND="WSL VM"
else
  HOST_KIND="host"
fi

# Current kernel boot epoch (changes only on a real (re)boot of the VM/host).
btime="$(awk '/^btime/{print $2}' /proc/stat 2>/dev/null)"
if [[ -z "${btime:-}" ]]; then
  log "no btime in /proc/stat; nothing to do"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
prev=""
[[ -f "$STATE_FILE" ]] && prev="$(tr -dc '0-9' <"$STATE_FILE" 2>/dev/null)"

# Persist the current btime for the next run no matter what happens below.
echo "$btime" >"$STATE_FILE" 2>/dev/null || true

if [[ -z "$prev" ]]; then
  log "baseline initialised (btime=$btime); no alert on first run"
  exit 0
fi

if [[ "$prev" == "$btime" ]]; then
  log "btime unchanged ($btime) -- user-manager restart without a host reboot; no alert"
  exit 0
fi

# --- host/VM restart detected (btime changed) ---
boot_local="$(date -d "@$btime" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo "@$btime")"

# Estimate downtime: newest store/*.log mtime that predates this boot ~= last
# fleet activity before the VM went down. gap = boot_time - that mtime.
last_alive=0
if compgen -G "$STATE_DIR/*.log" >/dev/null 2>&1; then
  for f in "$STATE_DIR"/*.log; do
    m="$(stat -c '%Y' "$f" 2>/dev/null || echo 0)"
    if (( m < btime && m > last_alive )); then last_alive="$m"; fi
  done
fi
gap_txt="ismeretlen"
if (( last_alive > 0 )); then
  gap_min=$(( (btime - last_alive) / 60 ))
  last_txt="$(date -d "@$last_alive" '+%H:%M:%S' 2>/dev/null || echo '?')"
  gap_txt="~${gap_min} perc (utolsó aktivitás ${last_txt} előtt)"
fi

msg="Marveen ${HOST_KIND} restarted.
Új boot: ${boot_local}
Becsült kiesés: ${gap_txt}
(Ez host/VM szintű restart, NEM app-crash. A dashboard/channels app-crash külön OnFailure-értesítést küld.)"

log "host restart detected: prev btime=$prev new=$btime; sending Telegram"

# Best-effort Telegram send. Never let a send failure fail the unit.
token=""
if [[ -f "$ENV_FILE" ]]; then
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
fi
if [[ -n "$token" && -n "$CHAT_ID" ]]; then
  curl -s --max-time 15 \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${msg}" >/dev/null 2>&1 \
    && log "Telegram sent" || log "Telegram send failed (best-effort)"
else
  log "skipping Telegram (${HOST_KIND} restart still logged): missing${token:+}$( [[ -z "$token" ]] && echo ' TELEGRAM_BOT_TOKEN(via TELEGRAM_ENV)')$( [[ -z "$CHAT_ID" ]] && echo ' MARVEEN_ALERT_CHAT_ID')"
fi

exit 0
