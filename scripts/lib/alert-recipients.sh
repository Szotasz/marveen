#!/bin/bash
# alert-recipients.sh -- who gets a Marveen alert: ONE copy of the recipient resolution for
# unit-fail-notify.sh, host-restart-watchdog.sh and fleet-memory-gate.sh (b2e9c0c1, on the 615002e1 list).
#
#   alert_resolve_recipients INSTALL_ENV LOG_FN STORE_DIR
#
#   MARVEEN_ALERT_CHAT_ID may be a COMMA-SEPARATED LIST (615002e1): spaces and a trailing comma are not an error,
#   an empty element and the "0" installer placeholder (install-linux.sh:812) are dropped, and a single id is a
#   list of one. A SET value fully replaces the fallback below, even when nothing usable is left of it.
#
#   Fallback (ZAKARFELUGY921; kept, and pointed at the fleet's one owner-chat rule, by the 2026-09-27 decisions on
#   b2e9c0c1): nothing sets MARVEEN_ALERT_CHAT_ID today, so an EMPTY variable falls back to the owner chat of
#   lib/owner-chat.sh resolve_owner_chat_id (CHATID0) for the install .env: its ALLOWED_CHAT_ID (the "0" placeholder
#   refused), else the main install's access.json, and only when allowFrom holds exactly ONE DM entry -- more would
#   be a guess, a group or a channel never. The same rule notify.sh, limit-monitor.sh and the other alerts use.
#
#   Neither the fallback nor a missing recipient is silent. Both are logged through LOG_FN (the script's own log
#   channel) AND appended to STORE_DIR/alert-recipients.log, one line per event:
#     <UTC time> <script> fallback ...<last 4 digits of the id>
#     <UTC time> <script> no-recipient (<why>; for the fallback the owner-chat library's own reason, verbatim)
#   and every send tags the fallback recipient as such (alert_recipient_tag). Ids are masked to the last 4 digits.
#   No recipient is ever invented.
#
#   Sets ALERT_CHAT_IDS (array) and ALERT_RECIPIENT_SOURCE (list | fallback | none).
#   Returns 0 with at least one recipient, 1 without. The CALLER's exit code does not follow it: an OnFailure
#   handler and a oneshot watchdog exit 0, and the memory gate's code stays its allow/block decision.
#
#   alert_recipient_tag INDEX TOTAL CHAT_ID
#
#   The log tag of one recipient: its position, the id MASKED to the last 4 digits, and FALLBACK when it came
#   from the owner-chat rule -- enough to tell the recipients apart without spreading full chat ids through logs.
#
# Bash 3.2 compatible (macOS system bash), like lib/send-telegram.sh. Source it, do not execute it.

# _alert_recipients_event STORE_DIR LOG_FN EVENT DETAIL -- one line to the file (the script's log has its own line).
_alert_recipients_event() {
  local store="$1" log_fn="$2" event="$3" detail="$4" script="${0##*/}" now
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown-time)"
  if [[ -n "$store" ]] && mkdir -p "$store" 2>/dev/null && echo "$now $script $event $detail" >>"$store/alert-recipients.log" 2>/dev/null; then
    return 0
  fi
  "$log_fn" "could not append to ${store:-<no store dir>}/alert-recipients.log -- the $event event is only in this log"
}

alert_resolve_recipients() {
  local install_env="$1" log_fn="$2" store="$3" raw="${MARVEEN_ALERT_CHAT_ID:-}" id="" res rc lib_dir
  ALERT_CHAT_IDS=()
  ALERT_RECIPIENT_SOURCE="none"
  if [[ -n "$raw" ]]; then
    local _split=()
    IFS=',' read -r -a _split <<< "$raw"
    for id in "${_split[@]+"${_split[@]}"}"; do
      id="${id//[[:space:]]/}"
      [[ -n "$id" && "$id" != "0" ]] && ALERT_CHAT_IDS+=("$id")
    done
    if [[ ${#ALERT_CHAT_IDS[@]} -gt 0 ]]; then
      ALERT_RECIPIENT_SOURCE="list"
      return 0
    fi
    "$log_fn" "ALERT HAS NO RECIPIENT: MARVEEN_ALERT_CHAT_ID is set but holds no usable id (only the \"0\" placeholder or empty elements); a set value is never replaced by the owner-chat fallback -- nothing will be sent"
    _alert_recipients_event "$store" "$log_fn" no-recipient "(MARVEEN_ALERT_CHAT_ID set, no usable id)"
    return 1
  fi

  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! . "$lib_dir/owner-chat.sh" 2>/dev/null || ! command -v resolve_owner_chat_id >/dev/null 2>&1; then
    res="the owner-chat library ($lib_dir/owner-chat.sh) could not be loaded"; rc=1
  else
    # stdout: the id; stderr: the library's one reason line when there is none. Kept together, told apart by rc.
    res="$(resolve_owner_chat_id "$install_env" 2>&1)"; rc=$?
  fi
  if [[ $rc -eq 0 && -n "$res" && "$res" != *[[:space:]]* ]]; then
    id="$res"
    ALERT_CHAT_IDS=("$id")
    ALERT_RECIPIENT_SOURCE="fallback"
    "$log_fn" "MARVEEN_ALERT_CHAT_ID is empty: the alert goes to the FALLBACK recipient, the owner chat of lib/owner-chat.sh for $install_env (...${id: -4})"
    _alert_recipients_event "$store" "$log_fn" fallback "...${id: -4}"
    return 0
  fi
  [[ $rc -eq 0 ]] && res="the owner-chat resolver returned no single id"
  res="$(printf '%s' "$res" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  "$log_fn" "ALERT HAS NO RECIPIENT: MARVEEN_ALERT_CHAT_ID is empty and the owner-chat fallback gave none ($res) -- nothing will be sent, no recipient is invented"
  _alert_recipients_event "$store" "$log_fn" no-recipient "(MARVEEN_ALERT_CHAT_ID empty; $res)"
  return 1
}

alert_recipient_tag() {
  local who="recipient"
  [[ "${ALERT_RECIPIENT_SOURCE:-}" == "fallback" ]] && who="FALLBACK recipient (owner chat, lib/owner-chat.sh)"
  printf '%s %s/%s (...%s)' "$who" "$1" "$2" "${3: -4}"
}
