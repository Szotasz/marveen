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
[[ -r "$TOKEN_FILE" ]] || { echo "FAIL: no dashboard token at ${TOKEN_FILE}" >&2; exit 3; }

# The HTTP status is checked, not assumed: a 404 body would otherwise print as an empty message.
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
CODE="$(curl -s -o "$OUT" -w '%{http_code}' \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
  "http://localhost:3420/api/messages/${ID}")"
if [[ "$CODE" != "200" ]]; then
  echo "FAIL: GET /api/messages/${ID} -> HTTP ${CODE}" >&2
  head -c 400 "$OUT" >&2; echo >&2
  exit 4
fi

python3 - "$OUT" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding='utf-8'))
print(f"# msg {m.get('id')}  {m.get('from_agent')} -> {m.get('to_agent')}  status={m.get('status')}")
print("\n--- CONTENT ---")
print(m.get('content') or '(nincs)')
print("\n--- RESULT ---")
print(m.get('result') or '(nincs eredmény)')
PY
