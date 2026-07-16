#!/bin/bash
# Contract tests for telegram_progress_watchdog.py -- the wedged-turn sentry.
# Run: bash scripts/__tests__/telegram-watchdog-wedged.test.sh
#
# Locks the item-(b) fix: when a turn is WEDGED (agent up, but the reply MCP
# call is hung so the turn never ends), the watchdog must (1) react well before
# the 15-min blunt backstop and (2) deliver the agent's REAL answer, not a
# generic error. A legitimately long task (no hung reply) must NOT be touched
# before the backstop.
#
# Fully hermetic: HOME and MARVEEN_ROOT are pinned to a temp tree so the
# watchdog only ever scans test dirs (never the real ~/.claude), and all Bot API
# traffic is routed to a local stub via TELEGRAM_API_BASE.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="$INSTALL_DIR/scripts/hooks/telegram_progress_watchdog.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Bot API stub (logs "<method> <body>" per request) -----------------
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        out = {"ok": True, "result": {"message_id": 9001}}
        payload = json.dumps(out).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[2], "w") as f: f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
[ -z "$PORT" ] && { echo "FATAL: stub did not start"; exit 1; }
API_BASE="http://127.0.0.1:$PORT"

CHAT="10000000001"
ANSWER="EZ_A_VALODI_VALASZ amit a usernek latnia kell"

# Build a per-case agent state dir + transcript, then return the progress dir.
# kind = hung  -> last tool_use is a Telegram reply with NO result (round hung)
# kind = work  -> last tool_use is a Bash WITH a result (legit long task)
# kind = noans -> hung reply but NO assistant text (nothing to deliver)
make_case() { # name kind age_seconds
    local name="$1" kind="$2" age="$3"
    local pdir="$TMP/root/agents/$name/.claude/channels/telegram/progress"
    local sdir="$TMP/root/agents/$name/.claude/channels/telegram"
    mkdir -p "$pdir"
    printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$sdir/.env"
    local tr="$sdir/transcript.jsonl"
    case "$kind" in
      hung)
        { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"}]}}';
          printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tuReply1","name":"mcp__plugin_telegram_telegram__reply"}]}}'; } > "$tr" ;;
      noans)
        printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tuReply1","name":"mcp__plugin_telegram_telegram__reply"}]}}' > "$tr" ;;
      work)
        { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"},{"type":"tool_use","id":"tuBash1","name":"Bash"}]}}';
          printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tuBash1"}]}}'; } > "$tr" ;;
    esac
    printf '[{"chat_id":"%s","message_id":555,"transcript_path":"%s"}]\n' "$CHAT" "$tr" \
        > "$pdir/SID.json"
    # Backdate the state file so its age exceeds the tested threshold.
    python3 - "$pdir/SID.json" "$age" <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
    echo "$pdir"
}
pend_exists() { [ -f "$1/SID.json" ] && echo yes || echo no; }
# REQLOG always exists (recreated per run); grep -c prints exactly one integer
# line ("0" on no match) -- no `|| echo 0` fallback (that would double the 0).
count() { grep -c "^$1 " "$REQLOG" 2>/dev/null; }
body_has() { grep -q "$1" "$REQLOG" && echo yes || echo no; }
run_wd() { # force_up wedged_up_sec
    : > "$REQLOG"
    HOME="$TMP" MARVEEN_ROOT="$TMP/root" TELEGRAM_API_BASE="$API_BASE" \
      TELEGRAM_WATCHDOG_FORCE_AGENT_UP="$1" TELEGRAM_WATCHDOG_WEDGED_UP_SEC="$2" \
      python3 "$WATCHDOG"
}

echo "telegram-watchdog-wedged tests"
echo "=============================="

# ---------------------------------------------------------------------------
# (a) Agent UP + hung reply + past the fast threshold -> deliver REAL answer
# ---------------------------------------------------------------------------
echo ""
echo "(a) Wedged (hung reply): fast, real answer"
PA="$(make_case wa hung 100)"
run_wd 1 1
assert_eq "fires fast: one real-answer sendMessage" "1" "$(count sendMessage)"
assert_eq "delivers the REAL answer text (not a generic error)" "yes" "$(body_has "EZ_A_VALODI_VALASZ")"
assert_eq "clears the placeholder (deleteMessage)" "1" "$(count deleteMessage)"
assert_eq "no generic-error edit" "0" "$(count editMessageText)"
assert_eq "state file removed after handling" "no" "$(pend_exists "$PA")"

# ---------------------------------------------------------------------------
# (b) Agent UP + NO hung reply, before the backstop -> DO NOT touch it
# ---------------------------------------------------------------------------
echo ""
echo "(b) Legit long task (no hung reply): untouched before backstop"
PB="$(make_case wb work 100)"
run_wd 1 1
assert_eq "no delivery for a legitimately working task" "0" "$(count sendMessage)"
assert_eq "no error edit for a working task" "0" "$(count editMessageText)"
assert_eq "placeholder preserved (task still running)" "yes" "$(pend_exists "$PB")"

# ---------------------------------------------------------------------------
# (c) Agent UP + no hung reply but past the 15-min backstop -> fire
# ---------------------------------------------------------------------------
echo ""
echo "(c) Backstop: no hung reply but very old -> fire with real answer"
PC="$(make_case wc work 1000)"   # 1000s > WEDGED_SEC (900)
run_wd 1 1
assert_eq "backstop fires: one delivery" "1" "$(count sendMessage)"
assert_eq "state file removed" "no" "$(pend_exists "$PC")"

# ---------------------------------------------------------------------------
# (d) Agent DOWN + past the down grace -> fire with real answer
# ---------------------------------------------------------------------------
echo ""
echo "(d) Agent down: fire with real answer"
PD="$(make_case wd hung 200)"    # 200s > DOWN_GRACE_SEC (120)
run_wd 0 1
assert_eq "down path fires: one delivery" "1" "$(count sendMessage)"
assert_eq "delivers the real answer" "yes" "$(body_has "EZ_A_VALODI_VALASZ")"

# ---------------------------------------------------------------------------
# (e) Hung reply but NO recoverable answer -> generic error, keep placeholder
# ---------------------------------------------------------------------------
echo ""
echo "(e) Nothing to deliver: falls back to generic error edit"
PE="$(make_case we noans 100)"
run_wd 1 1
assert_eq "no real-answer send (nothing to deliver)" "0" "$(count sendMessage)"
assert_eq "rewrites placeholder into a generic error" "1" "$(count editMessageText)"
assert_eq "error text used" "yes" "$(body_has "Valami elakadt")"

# ---------------------------------------------------------------------------
echo ""
echo "=============================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
