#!/bin/bash
# BASHSANDBOX1022 end-to-end measurement: does a Claude Code session started with an agent's
# sandbox --settings file let a python3 script WRITTEN TO A FILE reach the allowed host and NOT the
# denied one? This is the hole the bash-egress-parser hook cannot see (it reads the command line).
#
# It starts a real, throwaway child `claude -p` -- its own empty CLAUDE_CONFIG_DIR, no plugins, a
# temp cwd outside the repo, --dangerously-skip-permissions like the fleet -- and asks it to run the
# probe through the Bash tool. The verdict comes from the probe's own JSON, never from the model's
# reply. Costs one short model call; not part of the vitest suite.
#
# Usage: bash scripts/bash-sandbox-e2e.sh <settings.json> [allowed-host] [denied-host]
#   e.g. bash scripts/bash-sandbox-e2e.sh store/bash-sandbox/soma.settings.json dentalsalon.hu example.com
# Exit 0: allowed host answered, denied host refused, localhost:3420 reachable. 1: any of them not.
# Run it once against a file WITHOUT network.strictAllowlist to see it fail (bypass mode lets the
# denied host through then): that is the check that this measurement can say no.
set -u
SETTINGS="${1:?usage: bash-sandbox-e2e.sh <settings.json> [allowed-host] [denied-host]}"
ALLOW="${2:-dentalsalon.hu}"
DENY="${3:-example.com}"
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude)}"
# The fleet token, as the agents get it; overridable for a worktree that has no store/.
TOKEN_FILE="${MARVEEN_OAUTH_TOKEN_FILE:-$INSTALL_DIR/store/.claude-oauth-token}"
[ -f "$SETTINGS" ] || { echo "no such settings file: $SETTINGS" >&2; exit 2; }
[ -s "$TOKEN_FILE" ] || { echo "no fleet token at $TOKEN_FILE" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/bash-sandbox-e2e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/cfg" "$WORK/cwd" "$WORK/tg"
printf '{"skipDangerousModePermissionPrompt": true}\n' > "$WORK/cfg/settings.json"
cat > "$WORK/cwd/probe.py" <<'PY'
import json, sys, urllib.request
def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "marveen-sandbox-e2e/1"}), timeout=15) as r:
            return f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except Exception as e:
        return f"BLOCKED {type(e).__name__}: {e}"[:200]
allow, deny, out = sys.argv[1:4]
json.dump({"allow": get(f"https://{allow}/"), "deny": get(f"https://{deny}/"),
           "dashboard": get("http://127.0.0.1:3420/")}, open(out, "w"))
PY
cd "$WORK/cwd" || exit 2
# Launched like the fleet launches an agent: no Agent view, and IS_SANDBOX on a root host (ROOTRESPAWN1001).
[ "$(id -u)" != 0 ] || export IS_SANDBOX=1
env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET \
    -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_CHILD_SESSION \
    CLAUDE_CONFIG_DIR="$WORK/cfg" TELEGRAM_STATE_DIR="$WORK/tg" CLAUDE_CODE_DISABLE_AGENT_VIEW=1 \
    CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")" \
  "$CLAUDE_BIN" -p "Use the Bash tool once to run exactly: python3 probe.py $ALLOW $DENY result.json   Do not change or retry it. Then reply DONE." \
    --model claude-haiku-5-5 --strict-mcp-config --dangerously-skip-permissions --settings "$SETTINGS" \
    > "$WORK/claude.out" 2>&1
[ -f "$WORK/cwd/result.json" ] || { echo "FAIL: the probe did not run (claude output follows)"; tail -5 "$WORK/claude.out"; exit 1; }
python3 - "$WORK/cwd/result.json" "$ALLOW" "$DENY" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); allow, deny = sys.argv[2:4]
ok_allow = r["allow"].startswith("HTTP ")
ok_deny = r["deny"].startswith("BLOCKED")
ok_dash = r["dashboard"].startswith("HTTP ")
print(f"allowed {allow}: {r['allow']}  -> {'ok' if ok_allow else 'FAIL'}")
print(f"denied  {deny}: {r['deny']}  -> {'ok' if ok_deny else 'FAIL'}")
print(f"dashboard 127.0.0.1:3420: {r['dashboard']}  -> {'ok' if ok_dash else 'FAIL'}")
sys.exit(0 if ok_allow and ok_deny and ok_dash else 1)
PY
