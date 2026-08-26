#!/bin/bash
# send-telegram.sh -- the fleet's ONE honest Telegram send primitive.
#
# NOTIFYVAKSWEEP826: 13 scripts sent to the Bot API; only notify.sh (after
# NOTIFYVAK826/#1081) and telegram_fallback_send.py checked the outcome. Every
# bash sender either swallowed the curl exit, ignored the response body, or
# both -- an HTTP 200 with {"ok":false} (bad chat_id, blocked bot, mangled
# .env) was invisible everywhere, and several loggers printed unconditional
# "sent" on failure. This library IS the proven notify.sh contract, extracted
# so there is exactly one truth:
#
#   send_telegram_message TOKEN CHAT_ID TEXT [extra curl args...]
#
#   returns 0  ONLY when curl exited 0 AND the Bot API answered "ok":true
#   returns 1  on transport failure, API rejection, or misuse (empty args),
#              with the reason on stderr and the bot token redacted (some curl
#              errors quote the request URL).
#
# The caller decides what a failure means for its own exit code (an OnFailure
# unit must still exit 0; notify.sh exits 1) -- but it can no longer NOT KNOW.
# State stamps (dedupe hashes, cooldowns, baselines) must be written only
# after this returns 0: a failed alert buried by its own suppression stamp is
# lost forever (the limit-monitor failure mode).
#
# Bash 3.2 compatible (macOS system bash). Source it, do not execute it:
#   . "$(dirname "$0")/lib/send-telegram.sh"

send_telegram_message() {
  if [ "$#" -lt 3 ]; then
    echo "send_telegram_message: usage: send_telegram_message TOKEN CHAT_ID TEXT [curl args...]" >&2
    return 1
  fi
  local token="$1" chat_id="$2" text="$3"
  shift 3
  if [ -z "$token" ] || [ -z "$chat_id" ] || [ -z "$text" ]; then
    echo "send_telegram_message: empty token/chat_id/text -- refusing (nothing would be delivered)" >&2
    return 1
  fi

  local response curl_exit
  response=$(curl -sS -m 15 "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${text}" \
    "$@" 2>&1)
  curl_exit=$?
  # Never let the token reach a log/journal: redact before any echo.
  response="${response//${token}/<token>}"

  if [ "$curl_exit" -ne 0 ]; then
    echo "send_telegram_message: transport failure (curl exit ${curl_exit}): ${response}" >&2
    return 1
  fi
  case "$response" in
    *'"ok":true'*)
      return 0
      ;;
    *)
      echo "send_telegram_message: Bot API rejected the send: ${response}" >&2
      return 1
      ;;
  esac
}
