#!/usr/bin/env bash
# marveen-api.sh -- the dashboard-API calls a sub-agent's CLAUDE.md prescribes, with no `$(cat token)`.
#
# WHY (#2232): a strict-profile agent runs under `defaultMode: dontAsk`, where a command
# substitution never matches the allow-list, so every `curl ... -H "Authorization: Bearer
# $(cat <token>)"` recipe was auto-denied. This one allow-listed entry point reads the token
# itself (scripts/lib/marveen_api.py, never in an argv) and takes every payload from a file.
#
# Usage: bash scripts/marveen-api.sh <verb> [args]   (bash scripts/marveen-api.sh --help lists them)
#   message <from> <to> <content-file> [--priority high|normal]
#     runs the existing scripts/agent-msg.sh (its checks, retries and failure log), the text from
#     the file on its stdin.
#   every other verb: scripts/lib/marveen_api.py.
# Env: the same as agent-msg.sh -- MARVEEN_API_BASE, MARVEEN_WEB_PORT, WEB_PORT, MARVEEN_TOKEN_FILE.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "message" ]; then
  shift
  # agent-msg.sh reads MARVEEN_API_BASE and MARVEEN_TOKEN_FILE too: the same guard first.
  python3 "$DIR/lib/marveen_api.py" --check-env || exit 2
  PRIORITY=()
  ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --priority) [ "$#" -ge 2 ] || { echo "FAIL: --priority needs a value" >&2; exit 2; }; PRIORITY=(--priority "$2"); shift 2 ;;
      --priority=*) PRIORITY=(--priority "${1#--priority=}"); shift ;;
      --*) echo "FAIL: message: unknown option $1" >&2; exit 2 ;;
      *) ARGS+=("$1"); shift ;;
    esac
  done
  if [ "${#ARGS[@]}" -ne 3 ]; then
    echo "FAIL: usage: bash scripts/marveen-api.sh message <from> <to> <content-file> [--priority high|normal]" >&2
    exit 2
  fi
  FROM="${ARGS[0]}"; TO="${ARGS[1]}"; FILE="${ARGS[2]}"
  if [ "$FILE" = "-" ]; then
    exec bash "$DIR/agent-msg.sh" ${PRIORITY[@]+"${PRIORITY[@]}"} "$FROM" "$TO" -
  fi
  [ -r "$FILE" ] || { echo "FAIL: cannot read $FILE; nothing was sent." >&2; exit 2; }
  exec bash "$DIR/agent-msg.sh" ${PRIORITY[@]+"${PRIORITY[@]}"} "$FROM" "$TO" - < "$FILE"
fi

exec python3 "$DIR/lib/marveen_api.py" "$@"
