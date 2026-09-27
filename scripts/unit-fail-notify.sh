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
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# #915: main channel state is install-scoped once migrated; the legacy shared
# path only serves unmigrated installs.
TG_CHAN_DIR="${TELEGRAM_STATE_DIR:-}"
if [ -z "$TG_CHAN_DIR" ]; then
  TG_CHAN_DIR="$INSTALL_DIR/.claude/channels/telegram"
  [ -f "$TG_CHAN_DIR/.env" ] || TG_CHAN_DIR="$HOME/.claude/channels/telegram"
fi
ENV_FILE="${TELEGRAM_ENV:-$TG_CHAN_DIR/.env}"
ACCESS_JSON="${TELEGRAM_ACCESS:-$TG_CHAN_DIR/access.json}"
# Alert recipients: MARVEEN_ALERT_CHAT_ID (a comma-separated list, 615002e1), or -- only when it is empty -- the
# first allowFrom entry of access.json. Resolved, logged and recorded by lib/alert-recipients.sh, the one copy for
# the three alert scripts (b2e9c0c1). There is deliberately NO hardcoded id: a hardcoded id would make every
# downstream install send its alerts to that one private chat via its own bot token.

now_local="$(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo now)"
msg="Marveen app-crash: a(z) ${UNIT} unit FAILED állapotba került (${now_local}).
(Ez alkalmazás/service szintű hiba, NEM host/VM restart. A host-restartot a host-restart-watchdog jelzi külön.)"

token=""
if [[ -f "$ENV_FILE" ]]; then
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
fi
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/alert-recipients.sh"
_ufn_log() { echo "[unit-fail-notify] $*" >&2; }
# No recipient: the resolver logs it, records it and returns non-zero; this OnFailure handler still exits 0.
CHAT_IDS=()
if alert_resolve_recipients "$ACCESS_JSON" _ufn_log "${MARVEEN_STORE:-$INSTALL_DIR/store}"; then
  CHAT_IDS=("${ALERT_CHAT_IDS[@]}")
fi
if [[ -n "$token" && ${#CHAT_IDS[@]} -gt 0 ]]; then
  # Honest send (NOTIFYVAKSWEEP826): the unit stays best-effort (exit 0 either
  # way, an OnFailure handler must never itself enter `failed`), but a delivery
  # failure now lands in the journal instead of vanishing -- this is the script
  # that reports app crashes, so its own silence was the worst kind.
  . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/send-telegram.sh"
  _total=${#CHAT_IDS[@]}; _ok=0; _bad=0; _i=0
  for _cid in "${CHAT_IDS[@]}"; do
    _i=$((_i + 1))
    # Masked (last 4) + position, and FALLBACK when the id came from access.json (lib/alert-recipients.sh).
    _tag="$(alert_recipient_tag "$_i" "$_total" "$_cid")"
    # NOTE: no `break`/`exit` in this loop on purpose -- a failing recipient must
    # not decide for the others. That is the whole point of the change.
    if send_telegram_message "$token" "$_cid" "$msg"; then
      _ok=$((_ok + 1))
      echo "[unit-fail-notify] ${UNIT} FAILED notice delivered -- ${_tag}" >&2
    else
      _bad=$((_bad + 1))
      echo "[unit-fail-notify] ${UNIT} FAILED but the Telegram notice did NOT deliver -- ${_tag} (see error above)" >&2
    fi
  done
  echo "[unit-fail-notify] ${UNIT}: ${_ok}/${_total} recipient(s) delivered, ${_bad} failed" >&2
else
  # Not silent: name the missing piece so a misconfigured install is diagnosable.
  miss=""; [[ -z "$token" ]] && miss+=" TELEGRAM_BOT_TOKEN(via TELEGRAM_ENV=$ENV_FILE)"; [[ ${#CHAT_IDS[@]} -eq 0 ]] && miss+=" MARVEEN_ALERT_CHAT_ID(and no access.json fallback, see above)"
  echo "[unit-fail-notify] ${UNIT} FAILED but no Telegram sent -- missing:${miss}" >&2
fi
exit 0
