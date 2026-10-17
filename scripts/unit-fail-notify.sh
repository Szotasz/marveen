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
# Alert recipients: MARVEEN_ALERT_CHAT_ID (a comma-separated list, 615002e1), or -- only when it is empty -- the
# owner chat of lib/owner-chat.sh (the install .env's ALLOWED_CHAT_ID, else a single-entry access.json allowFrom).
# Resolved, logged and recorded by lib/alert-recipients.sh, the one copy for the three alert scripts (b2e9c0c1).
# There is deliberately NO hardcoded id: a hardcoded id would make every downstream install send its alerts to
# that one private chat via its own bot token.

now_local="$(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || echo now)"

# Per-unit label and reason (9318442d): the OnFailure path stays, and the notice
# says WHAT failed and WHY, read from the FAILED RUN itself:
#  - a guard whose alert IS its OnFailure prints a marker line and then exits non-zero on purpose. The markers in use
#    (measured on the guards of one install, 2026-09-29): "PROBLEMA:" (e.g. "<guard>: ⛔ PROBLEMA:<what>"), and
#    "RIASZTAS" / "RIASZTÁS". Such a run (Result exit-code, a marker line in its own output) is an "őr-jelzés" (a guard's
#    signal), not an app crash, and the last marker line is the reason;
#  - any other failure keeps the "app-crash" label, with systemd's own reason: a guard's OWN error (no marker line in
#    that run), and every signal, timeout or oom-kill, whatever the run printed before it.
# A marker line starts at the start of the line (the guards print it so), and a run that printed a Python traceback
# crashed, whatever else it printed: a traceback echoes the source lines of its frames, indented, and the exception
# text; on a guard's alert path those carry the marker word (found in review: an unwritable event log, and a None in the
# PROBLEMA line's join, both labelled "not a crash" before this).
# The marker is read from the failed run's own output only (its InvocationID), so a line of an earlier run can never
# label a later failure. Every step is best-effort: without systemctl or journalctl, or when they say nothing, the
# notice is today's text.
UNIT_SCOPE=""
for _scope in --user --system; do
  if [ "$(systemctl "$_scope" show -p LoadState --value "$UNIT" 2>/dev/null)" = "loaded" ]; then UNIT_SCOPE="$_scope"; break; fi
done
unit_prop() { [ -n "$UNIT_SCOPE" ] && systemctl "$UNIT_SCOPE" show -p "$1" --value "$UNIT" 2>/dev/null; }
# Control characters out (the line is someone's output), and a bound on the length: this is a Telegram notice.
# cut counts bytes: iconv -c then drops a multibyte character the cut split (and any invalid byte), so the notice
# stays valid UTF-8; without iconv the text goes as cut left it.
_utf8() { if command -v iconv >/dev/null 2>&1; then iconv -f UTF-8 -t UTF-8 -c 2>/dev/null; else cat; fi; }
_clean() { tr -d '\000-\010\013-\037\177' | tr '\n\t' '  ' | cut -c1-300 | _utf8 | sed 's/[[:space:]]*$//'; }
guard_line=""; why=""; label_desc=""
if [ -n "$UNIT_SCOPE" ]; then
  _inv="$(unit_prop InvocationID)"
  _result="$(unit_prop Result)"; _status="$(unit_prop ExecMainStatus)"
  if [ -n "$_inv" ] && [ "$_result" = "exit-code" ]; then
    _run_out="$(journalctl "$UNIT_SCOPE" "_SYSTEMD_INVOCATION_ID=$_inv" -o cat --no-pager 2>/dev/null)"
    if ! printf '%s\n' "$_run_out" | grep -q '^Traceback (most recent call last):'; then
      guard_line="$(printf '%s\n' "$_run_out" | grep -E '^[^[:space:]]' | grep -E 'PROBLEMA:|RIASZTAS|RIASZTÁS' | tail -n 1 | _clean)"
    fi
  fi
  case "$_result" in
    exit-code) why="kilépési kód ${_status:-?}" ;;
    signal|core-dump) why="jelzés ${_status:-?} (${_result})" ;;
    timeout) why="időtúllépés" ;;
    oom-kill) why="elfogyott a memória (oom-kill)" ;;
    ""|success) why="" ;;
    *) why="$(printf '%s' "$_result" | _clean)" ;;
  esac
  label_desc="$(unit_prop Description | _clean)"
fi
unit_label="${UNIT}${label_desc:+ (${label_desc})}"
if [ -n "$guard_line" ]; then
  msg="Marveen őr-jelzés: a(z) ${unit_label} problémát jelez (${now_local}).
Ok: ${guard_line}
(Ez NEM összeomlás: az őr a futása végén jelez, a riasztás útja a unit OnFailure-je.)"
else
  msg="Marveen app-crash: a(z) ${unit_label} unit FAILED állapotba került (${now_local}).${why:+
Ok (systemd): ${why}}
(Ez alkalmazás/service szintű hiba, NEM host/VM restart. A host-restartot a host-restart-watchdog jelzi külön.)"
fi

token=""
if [[ -f "$ENV_FILE" ]]; then
  token="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r\n')"
fi
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/alert-recipients.sh"
_ufn_log() { echo "[unit-fail-notify] $*" >&2; }
# No recipient: the resolver logs it, records it and returns non-zero; this OnFailure handler still exits 0.
CHAT_IDS=()
if alert_resolve_recipients "$INSTALL_DIR/.env" _ufn_log "${MARVEEN_STORE:-$INSTALL_DIR/store}"; then
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
    # Masked (last 4) + position, and FALLBACK when the id came from the owner-chat rule (lib/alert-recipients.sh).
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
  miss=""; [[ -z "$token" ]] && miss+=" TELEGRAM_BOT_TOKEN(via TELEGRAM_ENV=$ENV_FILE)"; [[ ${#CHAT_IDS[@]} -eq 0 ]] && miss+=" MARVEEN_ALERT_CHAT_ID(and no owner-chat fallback, see above)"
  echo "[unit-fail-notify] ${UNIT} FAILED but no Telegram sent -- missing:${miss}" >&2
fi
exit 0
