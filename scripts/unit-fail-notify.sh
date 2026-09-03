#!/usr/bin/env bash
# unit-fail-notify.sh <unit-name>
#
# Called by marveen-notify@.service via `OnFailure=marveen-notify@%n.service`
# drop-ins on marveen-dashboard.service / marveen-channels.service. Sends ONE
# Telegram notice that a specific APP/service unit failed -- as opposed to a
# host/WSL-VM restart, which is reported by host-restart-watchdog.sh. Keeping
# the two paths separate is what lets a fleet-wide silence be classified.
#
# Best-effort and always exits 0 so it never itself enters `failed`.

set -uo pipefail

UNIT="${1:-unknown.unit}"
ENV_FILE="${TELEGRAM_ENV:-$HOME/.claude/channels/telegram/.env}"
# Alert target chat-id -- MUST be provided by the install's own config; there is
# deliberately NO hardcoded fallback (a hardcoded id would make every downstream
# install send its alerts to that one private chat via its own bot token).
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"

now_local="$(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo now)"
msg="Marveen app-crash: a(z) ${UNIT} unit FAILED állapotba került (${now_local}).
(Ez alkalmazás/service szintű hiba, NEM host/VM restart. A host-restartot a host-restart-watchdog jelzi külön.)"

token=""
if [[ -f "$ENV_FILE" ]]; then
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
fi
if [[ -n "$token" && -n "$CHAT_ID" ]]; then
  # Honest send (NOTIFYVAKSWEEP826): the unit stays best-effort (exit 0 either
  # way, an OnFailure handler must never itself enter `failed`), but a delivery
  # failure now lands in the journal instead of vanishing -- this is the script
  # that reports app crashes, so its own silence was the worst kind.
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/send-telegram.sh"
  if send_telegram_message "$token" "$CHAT_ID" "$msg"; then
    echo "[unit-fail-notify] ${UNIT} FAILED notice delivered" >&2
  else
    echo "[unit-fail-notify] ${UNIT} FAILED but the Telegram notice did NOT deliver (see error above)" >&2
  fi
else
  # Not silent: name the missing piece so a misconfigured install is diagnosable.
  miss=""; [[ -z "$token" ]] && miss+=" TELEGRAM_BOT_TOKEN(via TELEGRAM_ENV=$ENV_FILE)"; [[ -z "$CHAT_ID" ]] && miss+=" MARVEEN_ALERT_CHAT_ID"
  echo "[unit-fail-notify] ${UNIT} FAILED but no Telegram sent -- missing:${miss}" >&2
fi
exit 0
