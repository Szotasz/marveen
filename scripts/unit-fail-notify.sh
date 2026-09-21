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
# Alert target chat-id -- MUST be provided by the install's own config; there is
# deliberately NO hardcoded fallback (a hardcoded id would make every downstream
# install send its alerts to that one private chat via its own bot token).
CHAT_ID="${MARVEEN_ALERT_CHAT_ID:-}"
# ZAKARFELUGY921 (kulso bejelentes, 2026-09-21): a MARVEEN_ALERT_CHAT_ID-t SEMMI
# nem allitotta be -- se unit-sablon, se az install-linux.sh (merve: 0 elofordulas
# mindkettoben) --, tehat ervenyes tokennel SEM ment ki semmi. Beegetni tilos, es a
# unitba irni sem lehet: a telepito a unitokat a PAROSITAS ELOTT irja ki, amikor a
# CHAT_ID meg a "0" placeholder (install-linux.sh:812, es a docs/channels.md ki is
# mondja ezt a sorrend-fuggest). Ezert FUTASIDOBEN oldjuk fel, ugyanazzal az alakkal,
# amit a scripts/fleet-memory-gate.sh mar hasznal: az access.json elso engedelyezett
# kuldoje -- ugyanaz a lista, amit a plugin befele is betartat, tehat a feloldott id
# kezbesitheto. Ures marad -> a kuldes kimarad es a hiany NEVESITVE naplozodik.
ACCESS_JSON="${TELEGRAM_ACCESS:-$(dirname "$ENV_FILE")/access.json}"
if [ -z "$CHAT_ID" ] && [ -f "$ACCESS_JSON" ] && command -v python3 >/dev/null 2>&1; then
  CHAT_ID="$(python3 -c 'import json,sys
try:
  a=json.load(open(sys.argv[1]));v=a.get("allowFrom") or []
  print(v[0] if v else "")
except Exception: print("")' "$ACCESS_JSON" 2>/dev/null)"
fi
[ "$CHAT_ID" = "0" ] && CHAT_ID=""

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
