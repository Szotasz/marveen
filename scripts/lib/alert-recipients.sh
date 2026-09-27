#!/bin/bash
# alert-recipients.sh -- who gets a Marveen alert: ONE copy of the recipient resolution for
# unit-fail-notify.sh, host-restart-watchdog.sh and fleet-memory-gate.sh (b2e9c0c1, on the 615002e1 list).
#
#   alert_resolve_recipients ACCESS_JSON LOG_FN STORE_DIR
#
#   MARVEEN_ALERT_CHAT_ID may be a COMMA-SEPARATED LIST (615002e1): spaces and a trailing comma are not an error,
#   an empty element and the "0" installer placeholder (install-linux.sh:812) are dropped, and a single id is a
#   list of one. A SET value fully replaces the fallback below, even when nothing usable is left of it.
#
#   Fallback (ZAKARFELUGY921, kept by the 2026-09-27 decision on b2e9c0c1): nothing sets MARVEEN_ALERT_CHAT_ID
#   today -- no unit template, no installer line, and a unit cannot carry it, because the installer writes the
#   units BEFORE pairing, while the chat id is still the "0" placeholder. So an EMPTY variable falls back, at run
#   time, to the FIRST allowFrom entry of the channel's access.json: the admin owner, on the list the plugin
#   enforces inbound, so the id is deliverable. Only the first entry: a later one is somebody else.
#
#   Neither the fallback nor a missing recipient is silent. Both are logged through LOG_FN (the script's own log
#   channel) AND appended to STORE_DIR/alert-recipients.log, one line per event:
#     <UTC time> <script> fallback ...<last 4 digits of the id>
#     <UTC time> <script> no-recipient <reason>
#   and every send tags the fallback recipient as such (alert_recipient_tag). Ids are masked to the last 4 digits.
#   An empty variable with a missing, unreadable or empty access.json gives NO recipient: no recipient is invented.
#
#   Sets ALERT_CHAT_IDS (array) and ALERT_RECIPIENT_SOURCE (list | fallback | none).
#   Returns 0 with at least one recipient, 1 without. The CALLER's exit code does not follow it: an OnFailure
#   handler and a oneshot watchdog exit 0, and the memory gate's code stays its allow/block decision.
#
#   alert_recipient_tag INDEX TOTAL CHAT_ID
#
#   The log tag of one recipient: its position, the id MASKED to the last 4 digits, and FALLBACK when it came
#   from access.json -- enough to tell the recipients apart without spreading full chat ids through the logs.
#
# Bash 3.2 compatible (macOS system bash), like lib/send-telegram.sh. Source it, do not execute it.

# _alert_recipients_event STORE_DIR LOG_FN EVENT DETAIL -- one line to the script's log and one to the file.
_alert_recipients_event() {
  local store="$1" log_fn="$2" event="$3" detail="$4" script="${0##*/}" now
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown-time)"
  if [[ -n "$store" ]] && mkdir -p "$store" 2>/dev/null && echo "$now $script $event $detail" >>"$store/alert-recipients.log" 2>/dev/null; then
    return 0
  fi
  "$log_fn" "could not append to ${store:-<no store dir>}/alert-recipients.log -- the $event event is only in this log"
}

# _alert_fallback_from_access ACCESS_JSON -- "ok <id>", or the reason there is none: missing | unreadable | empty.
_alert_fallback_from_access() {
  local f="$1" out
  [[ -e "$f" ]] || { echo "missing"; return 0; }
  [[ -r "$f" ]] || { echo "unreadable"; return 0; }
  command -v python3 >/dev/null 2>&1 || { echo "unreadable (no python3)"; return 0; }
  out="$(python3 -c 'import json, sys
try:
    text = open(sys.argv[1], encoding="utf-8").read()
except Exception:
    print("unreadable"); sys.exit(0)
if not text.strip():
    print("empty"); sys.exit(0)
try:
    a = json.loads(text)
except Exception:
    print("unreadable"); sys.exit(0)
v = a.get("allowFrom") if isinstance(a, dict) else None
if not isinstance(v, list) or not v:
    print("empty"); sys.exit(0)
f = str(v[0]).strip()
print("ok " + f if f not in ("", "0") else "empty")' "$f" 2>/dev/null)" || out=""
  echo "${out:-unreadable}"
}

alert_resolve_recipients() {
  local access_json="$1" log_fn="$2" store="$3" raw="${MARVEEN_ALERT_CHAT_ID:-}" id="" found
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
    "$log_fn" "ALERT HAS NO RECIPIENT: MARVEEN_ALERT_CHAT_ID is set but holds no usable id (only the \"0\" placeholder or empty elements); a set value is never replaced by the access.json fallback -- nothing will be sent"
    _alert_recipients_event "$store" "$log_fn" no-recipient "(MARVEEN_ALERT_CHAT_ID set, no usable id)"
    return 1
  fi

  found="$(_alert_fallback_from_access "$access_json")"
  if [[ "$found" == "ok "* ]]; then
    id="${found#ok }"
    ALERT_CHAT_IDS=("$id")
    ALERT_RECIPIENT_SOURCE="fallback"
    "$log_fn" "MARVEEN_ALERT_CHAT_ID is empty: the alert goes to the FALLBACK recipient, the first allowFrom entry of $access_json (...${id: -4})"
    _alert_recipients_event "$store" "$log_fn" fallback "...${id: -4}"
    return 0
  fi
  "$log_fn" "ALERT HAS NO RECIPIENT: MARVEEN_ALERT_CHAT_ID is empty and the access.json fallback gave none ($access_json: $found) -- nothing will be sent, no recipient is invented"
  _alert_recipients_event "$store" "$log_fn" no-recipient "(MARVEEN_ALERT_CHAT_ID empty, access.json: $found)"
  return 1
}

alert_recipient_tag() {
  local who="recipient"
  [[ "${ALERT_RECIPIENT_SOURCE:-}" == "fallback" ]] && who="FALLBACK recipient (access.json allowFrom[0])"
  printf '%s %s/%s (...%s)' "$who" "$1" "$2" "${3: -4}"
}
