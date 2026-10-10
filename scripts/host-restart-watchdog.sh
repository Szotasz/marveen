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
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# #915: main channel state is install-scoped once migrated; the legacy shared
# path only serves unmigrated installs.
TG_CHAN_DIR="${TELEGRAM_STATE_DIR:-}"
if [ -z "$TG_CHAN_DIR" ]; then
  TG_CHAN_DIR="$INSTALL_DIR/.claude/channels/telegram"
  [ -f "$TG_CHAN_DIR/.env" ] || TG_CHAN_DIR="$HOME/.claude/channels/telegram"
fi
ENV_FILE="${TELEGRAM_ENV:-$TG_CHAN_DIR/.env}"
# Alert recipients: MARVEEN_ALERT_CHAT_ID (a comma-separated list, 615002e1), or -- only when it is empty -- the
# owner chat of lib/owner-chat.sh (the install .env's ALLOWED_CHAT_ID, else a single-entry access.json allowFrom).
# Resolved, logged and recorded by lib/alert-recipients.sh, the one copy for the three alert scripts (b2e9c0c1).
# There is deliberately NO hardcoded id: a hardcoded id would make every downstream install send its alerts to
# that one private chat via its own bot token.

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
# HOSTWD_PROC_STAT exists for tests only (there is no /proc to stub on macOS).
PROC_STAT="${HOSTWD_PROC_STAT:-/proc/stat}"
btime="$(awk '/^btime/{print $2}' "$PROC_STAT" 2>/dev/null)"
if [[ -z "${btime:-}" ]]; then
  log "no btime in $PROC_STAT; nothing to do"
  exit 0
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
prev=""
[[ -f "$STATE_FILE" ]] && prev="$(tr -dc '0-9' <"$STATE_FILE" 2>/dev/null)"

# The btime baseline is persisted on init below, but after a DETECTED restart
# only once the notice actually delivered (see the send block): this is a
# one-shot message, and stamping before a failed send lost it forever
# (NOTIFYVAKSWEEP826). While the send keeps failing, every timer run retries.

if [[ -z "$prev" ]]; then
  echo "$btime" >"$STATE_FILE" 2>/dev/null || true
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
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/alert-recipients.sh"
# No recipient: the resolver logs it, records it and returns non-zero; the watchdog still exits 0.
CHAT_IDS=()
if alert_resolve_recipients "$INSTALL_DIR/.env" log "$STATE_DIR"; then
  CHAT_IDS=("${ALERT_CHAT_IDS[@]}")
fi
if [[ -n "$token" && ${#CHAT_IDS[@]} -gt 0 ]]; then
  # Honest send (curl exit 0 AND "ok":true -- an HTTP 200 with ok:false was
  # invisible here before). Baseline stamped ONLY on confirmed delivery: this
  # one-shot notice must survive a transient send failure by retrying on the
  # next run, not by being marked done.
  # b2e9c0c1: with a list, delivery is recorded PER RECIPIENT for this btime (DELIVERED_FILE, "<btime> <chat id>"
  # lines): a recipient already served is not sent again, a failed one retries on the next run, and the baseline is
  # stamped once every recipient has it. One failing recipient neither silences the others nor makes them get it twice.
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/send-telegram.sh"
  DELIVERED_FILE="$STATE_FILE.delivered"
  if [[ -f "$DELIVERED_FILE" ]]; then
    # a record of an earlier boot is stale: keep only this btime's lines
    grep -E "^${btime} " "$DELIVERED_FILE" >"$DELIVERED_FILE.tmp" 2>/dev/null || true
    mv -f "$DELIVERED_FILE.tmp" "$DELIVERED_FILE" 2>/dev/null || true
  fi
  _total=${#CHAT_IDS[@]}; _ok=0; _bad=0; _i=0
  for _cid in "${CHAT_IDS[@]}"; do
    _i=$((_i + 1))
    _tag="$(alert_recipient_tag "$_i" "$_total" "$_cid")"   # masked, FALLBACK-tagged (lib/alert-recipients.sh)
    if [[ -f "$DELIVERED_FILE" ]] && grep -qxF -- "${btime} ${_cid}" "$DELIVERED_FILE"; then
      _ok=$((_ok + 1))
      log "already delivered for this boot -- ${_tag}"
      continue
    fi
    # NOTE: no break/exit on a failure: a failing recipient must not decide for the others.
    if send_err="$(send_telegram_message "$token" "$_cid" "$msg" 2>&1)"; then
      _ok=$((_ok + 1))
      echo "${btime} ${_cid}" >>"$DELIVERED_FILE" 2>/dev/null || true
      log "Telegram sent -- ${_tag}"
    else
      _bad=$((_bad + 1))
      log "Telegram send FAILED -- ${_tag}, will retry next run: ${send_err}"
    fi
  done
  if (( _bad == 0 )); then
    echo "$btime" >"$STATE_FILE" 2>/dev/null || true
    rm -f "$DELIVERED_FILE" 2>/dev/null || true
    log "Telegram sent to all ${_total} recipient(s) (btime baseline stamped)"
  else
    log "Telegram: ${_ok}/${_total} recipient(s) delivered, ${_bad} failed -- baseline NOT stamped, the failed one(s) retry next run"
  fi
else
  log "skipping Telegram (${HOST_KIND} restart still logged): missing${token:+}$( [[ -z "$token" ]] && echo ' TELEGRAM_BOT_TOKEN(via TELEGRAM_ENV)')$( [[ ${#CHAT_IDS[@]} -eq 0 ]] && echo ' MARVEEN_ALERT_CHAT_ID(and no owner-chat fallback, see above)')"
fi

exit 0
