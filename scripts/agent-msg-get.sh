#!/usr/bin/env bash
# Print ONE inter-agent message in full -- content and result, untruncated.
#
# WHY THIS EXISTS: a completion notification carries only the first part of a long `result`,
# and then names this script. Before it, the marker pointed at "msg N's result field" with no
# way to read it: the list endpoint can only be queried per agent, so following the pointer
# meant fetching a conversation and filtering it by hand. Twice on 2026-08-12 the recipient
# gave up and asked for a resend instead -- which is precisely the work the notification was
# supposed to save.
#
#   bash scripts/agent-msg-get.sh <message-id>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ID="${1:-}"
[[ "$ID" =~ ^[0-9]+$ ]] || { echo "usage: bash scripts/agent-msg-get.sh <message-id>" >&2; exit 2; }

TOKEN_FILE="${ROOT}/store/.dashboard-token"
# Dashboard port: the same chain as agent-msg.sh (MARVEEN_WEB_PORT, WEB_PORT,
# this install's .env, 3420). It was a literal 3420 (#1869). The trailing `true` keeps
# a missing .env from ending the script under set -e/pipefail.
PORT="${MARVEEN_WEB_PORT:-${WEB_PORT:-$(sed -n 's/^WEB_PORT=//p' "$ROOT/.env" 2>/dev/null | head -1 | tr -d ' "'"'"''; true)}}"
PORT="${PORT:-3420}"
[[ -r "$TOKEN_FILE" ]] || { echo "FAIL: no dashboard token at ${TOKEN_FILE}" >&2; exit 3; }

TOKEN="$(cat "$TOKEN_FILE")"
# An exported TOKEN inherited from the caller keeps its export attribute through the assignment (Dani 65583): drop it.
export -n TOKEN
[[ -n "$TOKEN" ]] || { echo "FAIL: the dashboard token at ${TOKEN_FILE} is empty" >&2; exit 3; }

# The HTTP status is checked, not assumed: a 404 body would otherwise print as an empty message.
# VOICETOKENLEAK1101 round 3 (Dani 65569): the token never on curl's argv (ps shows it to every process of the same
# user) and never on disk: curl reads the Authorization header from a process substitution (printf is a builtin).
# TOKEN is not exported. An explicit template: a bare macOS mktemp ignores TMPDIR (measured).
OUT="$(mktemp "${TMPDIR:-/tmp}/agent-msg-get.XXXXXX")"; trap 'rm -f "$OUT"' EXIT
CODE="$(curl -s -o "$OUT" -w '%{http_code}' \
  -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
  "http://localhost:${PORT}/api/messages/${ID}")"
if [[ "$CODE" != "200" ]]; then
  echo "FAIL: GET /api/messages/${ID} -> HTTP ${CODE}" >&2
  head -c 400 "$OUT" >&2; echo >&2
  exit 4
fi

# The freshness/supersession note is printed BEFORE the content, not after.
# This script is one of the ways an agent gets a message body into its hands --
# the same state the router stamps on a delivered message has to travel with it
# here too, or the fix stops at the API boundary and the reader is back to
# acting on a possibly-revoked instruction. Above the content, because a warning
# under a long body is a warning nobody reads.
python3 - "$OUT" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding='utf-8'))
print(f"# msg {m.get('id')}  {m.get('from_agent')} -> {m.get('to_agent')}  status={m.get('status')}")
fresh = m.get('freshness') or {}
if fresh.get('note'):
    print(f"\n!! {fresh['note']}")
print("\n--- CONTENT ---")
print(m.get('content') or '(nincs)')
print("\n--- RESULT ---")
print(m.get('result') or '(nincs eredmény)')
PY
