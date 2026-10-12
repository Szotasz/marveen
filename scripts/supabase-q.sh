#!/bin/sh
# supabase-q.sh -- Supabase SQL an agent can run WITHOUT ever handling the PAT
# (PATSZIVARGAS912, 2026-09-14).
#
# WHY IT EXISTS, measured: the account-level Supabase PAT leaked into 167 places,
# and EVERY leak had the same shape -- an agent typed the literal value into its
# own command:
#
#     export SUPABASE_ACCESS_TOKEN="sbp_<40 hex>"   <- the value is now in the
#                                                      transcript AND in
#                                                      tool_call_log.input_summary
#
# 21 rows of tool_call_log and 2 inter-agent messages carry it that way. The
# skills invited it: they wrote `export SUPABASE_ACCESS_TOKEN="<vault: KEY>"`,
# and "put the vault value here" is an instruction to MATERIALISE the secret
# into a command string. A rotation alone would refill the same channel within
# days -- so the mechanism goes first, the new token second.
#
# THE PROPERTY THIS SCRIPT HAS: the agent's command line is
#     scripts/supabase-q.sh <project-ref> "<SQL>"
# and contains no secret. The token is read from the local vault INSIDE this
# process and handed to the child through the environment, never through argv,
# never through stdout.
#
# HONEST LIMIT: the value does exist in the child's environment for the life of
# the call, which is readable by the same OS user. That is the same exposure the
# Supabase MCP server already has, and it is bounded by one process; the leak
# this closes is the durable one (transcript, tool-call log, message history).
#
# EXIT CODES, three states kept apart on purpose:
#   0  the query ran (supabase's own exit code is passed through)
#   2  usage error (missing project-ref or SQL)
#   3  the token could not be fetched -- FAIL CLOSED, nothing is executed
set -eu

PROJ="${1:-}"
[ -n "$PROJ" ] || { echo "usage: supabase-q.sh <project-ref> <SQL> [extra supabase args...]" >&2; exit 2; }
shift
[ "$#" -gt 0 ] || { echo "usage: supabase-q.sh <project-ref> <SQL> [extra supabase args...]" >&2; exit 2; }

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VAULT_KEY="${SUPABASE_VAULT_KEY:-SUPABASE_NEW_TOKEN}"
DASH="${CLAW_DASHBOARD_ORIGIN:-http://localhost:3420}"
TOKEN_FILE="$ROOT/store/.dashboard-token"

[ -r "$TOKEN_FILE" ] || { echo "supabase-q: FAIL-CLOSED, a dashboard-token nem olvashato: $TOKEN_FILE" >&2; exit 3; }

# The vault call is localhost-only; the fetched value never reaches stdout.
PAT="$(curl -s -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
        "$DASH/api/vault/$VAULT_KEY" \
       | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("value",""))
except Exception:
    print("")' )"

if [ -z "$PAT" ]; then
  echo "supabase-q: FAIL-CLOSED, a vault nem adott erteket ($VAULT_KEY). Semmit nem futtattam." >&2
  exit 3
fi

# The token goes to the child through the ENVIRONMENT, not argv: `ps` shows the
# arguments of a running process to every user, the environment only to its owner.
SUPABASE_ACCESS_TOKEN="$PAT" exec supabase db query "$@" \
  --linked --project-ref "$PROJ" --output-format json
