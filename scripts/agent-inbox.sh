#!/usr/bin/env bash
# List the inter-agent messages addressed to an agent, with their content IN FULL -- or, when
# asked to shorten, with the cut stated and the command that prints the rest.
#
# WHY THIS EXISTS (card 71263d15 (B), 15060): on 2026-09-22 an agent listed its own queue with an
# ad-hoc command that printed content[:600] and nothing else, answered the first 49% of a
# 1217-character message, and saw the decisive sentence only when the router delivered the whole
# message twenty minutes later. The router had split nothing; the reader had, silently. A cut
# nobody can see reads exactly like a short message.
#
#   bash scripts/agent-inbox.sh <agent-id> [--all] [--limit N] [--max CHARS]
#     default   the PENDING messages addressed to <agent-id>, oldest first, content in full
#     --all     every status: the most recent --limit messages addressed to <agent-id>, looked up in
#               one page of the API (both directions together, at most 200 rows); when that page may
#               hold fewer incoming messages than asked, the cut is stated
#     --limit   pending: how many rows to ask the API for; --all: how many incoming to show (default 50)
#     --max     cut each content at CHARS characters, and say so on the same line:
#               "[... +K karakter levágva; teljes: bash scripts/agent-msg-get.sh <id>]"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="${1:-}"
[[ "$AGENT" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "usage: bash scripts/agent-inbox.sh <agent-id> [--all] [--limit N] [--max CHARS]" >&2; exit 2; }
shift
STATUS="pending"; LIMIT=50; MAX=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) STATUS=""; shift ;;
    --limit) [[ "${2:-}" =~ ^[0-9]+$ ]] || { echo "--limit needs a number" >&2; exit 2; }; LIMIT="$2"; shift 2 ;;
    --max) [[ "${2:-}" =~ ^[0-9]+$ ]] || { echo "--max needs a number" >&2; exit 2; }; MAX="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

TOKEN_FILE="${ROOT}/store/.dashboard-token"
[[ -r "$TOKEN_FILE" ]] || { echo "FAIL: no dashboard token at ${TOKEN_FILE}" >&2; exit 3; }

# --all (71263d15 K6.12, K6.13): the API lists BOTH directions in one page and caps the page at 200
# (src/web/routes/messages.ts), so the script asks for a full page and keeps the newest --limit
# INCOMING rows itself; WANT=-1 is the pending mode, which the API does not cut.
PAGE=200; WANT=-1
if [[ -n "$STATUS" ]]; then
  URL="http://localhost:3420/api/messages?agent=${AGENT}&limit=${LIMIT}&status=${STATUS}"
else
  URL="http://localhost:3420/api/messages?agent=${AGENT}&limit=${PAGE}"; WANT="$LIMIT"
fi

# The HTTP status is checked, not assumed: an error body would otherwise read as an empty inbox.
# curl's own failure (no dashboard: exit 7) must reach the FAIL line as HTTP 000, not end the
# script in silence under set -e (71263d15 K6.14).
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
CODE="$(curl -s -o "$OUT" -w '%{http_code}' -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$URL" || true)"
if [[ "$CODE" != "200" ]]; then
  echo "FAIL: GET ${URL#http://localhost:3420} -> HTTP ${CODE}" >&2
  head -c 400 "$OUT" >&2; echo >&2
  exit 4
fi

python3 - "$OUT" "$AGENT" "$MAX" "$WANT" "$PAGE" <<'PY'
import datetime, json, sys
path, agent, cut = sys.argv[1], sys.argv[2], int(sys.argv[3])
want = int(sys.argv[4]) if len(sys.argv) > 4 else -1
page = int(sys.argv[5]) if len(sys.argv) > 5 else 0
d = json.load(open(path, encoding='utf-8'))
listed = d if isinstance(d, list) else d.get('messages', [])
# The list endpoint returns both directions for an agent; an inbox is what came IN.
rows = sorted((m for m in listed if m.get('to_agent') == agent), key=lambda m: m.get('id') or 0)
cut_note = None
if want >= 0:
    if len(rows) > want:
        rows = rows[len(rows) - want:]
    elif len(rows) < want and len(listed) >= page:
        cut_note = (f"# a lista vágva lehet: a szerver egy lapon legfeljebb {page} sort ad, a két irányt együtt, "
                    f"és ezen a lapon {len(rows)} bejövő fért el a kért {want} helyett; régebbi bejövő is lehet")
print(f"# {len(rows)} message(s) to {agent}")
if cut_note:
    print(cut_note)
for m in rows:
    content = m.get('content') or ''
    ts = m.get('created_at')
    try:
        ts = datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except (TypeError, ValueError):
        pass
    print(f"\n# msg {m.get('id')}  {m.get('from_agent')} -> {m.get('to_agent')}  status={m.get('status')}  {ts}  {len(content)} karakter")
    note = (m.get('freshness') or {}).get('note')
    if note:
        print(f"!! {note}")
    if cut > 0 and len(content) > cut:
        # The cut is announced where the text stops, with the command that prints the rest.
        print(content[:cut] + f" [... +{len(content) - cut} karakter levágva; teljes: bash scripts/agent-msg-get.sh {m.get('id')}]")
    else:
        print(content)
PY
