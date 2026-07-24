#!/usr/bin/env bash
# ask-fable.sh -- run a one-shot prompt on Claude Fable (claude-fable-5) via the
# fleet OAuth token. This is the ONLY working way to reach Fable in this fleet:
# the Claude Code Task/sub-agent spawner silently falls back to sonnet-5 for
# "fable", but a direct `claude --model claude-fable-5` CLI call runs on Fable.
# Usage: scripts/ask-fable.sh "prompt"   |   echo "prompt" | scripts/ask-fable.sh
#   [--tools]  allow read/plan tools headlessly (for codebase-aware planning);
#              default is text-only (no tool use).
# Prints ONLY Fable's final text. Exits non-zero + warns if the call did NOT
# actually run on Fable (guards against a silent model fallback).
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="$REPO_ROOT/store/.claude-oauth-token"
[ -r "$TOKEN_FILE" ] || { echo "ask-fable: fleet token missing ($TOKEN_FILE)" >&2; exit 3; }

TOOLS=0
if [ "${1:-}" = "--tools" ]; then TOOLS=1; shift; fi
prompt="${*:-}"
if [ -z "$prompt" ] && [ ! -t 0 ]; then prompt="$(cat)"; fi
[ -n "$prompt" ] || { echo "usage: ask-fable.sh [--tools] \"prompt\"" >&2; exit 1; }

out="$(mktemp)"; trap 'rm -f "$out"' EXIT
perm=(); [ "$TOOLS" = "1" ] && perm=(--permission-mode bypassPermissions)

CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")" \
  claude --model claude-fable-5 "${perm[@]}" -p "$prompt" --output-format json > "$out" 2>/dev/null || {
    echo "ask-fable: claude call failed" >&2; cat "$out" >&2; exit 2; }

python3 - "$out" << 'PY'
import json,sys
d=json.load(open(sys.argv[1]))
mu=d.get("modelUsage") or {}
on_fable = any("fable" in k for k in mu)
res=d.get("result","")
if d.get("is_error"):
    sys.stderr.write("ask-fable: model returned an error: %s\n" % str(res)[:200]); sys.exit(2)
if not on_fable:
    sys.stderr.write("ask-fable: WARNING did NOT run on Fable (modelUsage=%s) -- refusing\n" % list(mu)); sys.exit(4)
sys.stdout.write(res)
PY
