#!/bin/bash
# Contract tests for the Telegram Bot API fallback de-duplication.
# Run: bash scripts/__tests__/telegram-fallback-dedup.test.sh
#
# Bug being locked out: when the reply MCP tool drops mid-turn, the agent sends
# its answer via the Bot API directly. A RAW send does not clear the "✍️
# Dolgozom rajta…" placeholder, so the Stop hook's enforce path re-delivers the
# same answer at turn end -> the user gets it TWICE, and gets nudged to reply.
#
# Fix under test: telegram_fallback_send.py sends AND clears the placeholder
# (mirroring the reply tool), so the Stop hook finds nothing pending -> no
# duplicate, no nudge, no restart.
#
# All Bot API traffic is routed to a local stub via TELEGRAM_API_BASE, so the
# tests are hermetic (no real Telegram calls) and can count what was sent.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOKS_DIR="$INSTALL_DIR/scripts/hooks"
FALLBACK="$HOOKS_DIR/telegram_fallback_send.py"
STOP_HOOK="$HOOKS_DIR/telegram_progress_clear.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Bot API stub -----------------------------------------------------
# Logs one line per request ("<method> <body>") to $REQLOG and returns Bot
# API-shaped JSON. Binds to an OS-assigned port, written to $PORTFILE.
REQLOG="$TMP/requests.log"
PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys, os
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]  # /bot<token>/<method>
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        if method == "sendMessage":
            out = {"ok": True, "result": {"message_id": 9001}}
        elif method == "deleteMessage":
            out = {"ok": True, "result": True}
        else:
            out = {"ok": True, "result": {}}
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[2], "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
# Wait for the stub to report its port.
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORTFILE" 2>/dev/null)"
if [ -z "$PORT" ]; then echo "FATAL: stub did not start"; exit 1; fi
export TELEGRAM_API_BASE="http://127.0.0.1:$PORT"

CHAT="10000000001"
SID="TESTSID"

# Per-case state dir with a token + a pending placeholder + a transcript whose
# last assistant message is the agent's final answer.
make_state() { # dir
    local sd="$1"
    mkdir -p "$sd/progress"
    printf 'TELEGRAM_BOT_TOKEN=TESTTOKEN\n' > "$sd/.env"
    # pending placeholder: message_id 555 is the "Dolgozom rajta…" bubble
    printf '[{"chat_id": "%s", "message_id": 555}]\n' "$CHAT" > "$sd/progress/$SID.json"
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"AGENT_FINAL_ANSWER"}]}}' \
        > "$sd/transcript.jsonl"
}
pend_has_chat() { # dir -> "yes"/"no"
    python3 - "$1/progress/$SID.json" "$CHAT" <<'PYEOF'
import json, sys
try:
    pend = json.load(open(sys.argv[1]))
except Exception:
    print("no"); sys.exit(0)
print("yes" if any(str(p.get("chat_id")) == sys.argv[2] for p in pend) else "no")
PYEOF
}
count() { grep -c "^$1 " "$REQLOG" 2>/dev/null || echo 0; }
run_stop() { # dir stop_active(true/false)
    local sd="$1" active="$2"
    printf '{"session_id":"%s","transcript_path":"%s","stop_hook_active":%s}' \
        "$SID" "$sd/transcript.jsonl" "$active" \
        | TELEGRAM_STATE_DIR="$sd" python3 "$STOP_HOOK"
}

echo "telegram-fallback-dedup tests"
echo "============================="

# ---------------------------------------------------------------------------
# (a) The helper delivers AND clears the placeholder
# ---------------------------------------------------------------------------
echo ""
echo "(a) Fallback helper: send + clear placeholder"
SD_A="$TMP/a"; make_state "$SD_A"
: > "$REQLOG"
assert_eq "pend has the chat before send" "yes" "$(pend_has_chat "$SD_A")"
OUT_A="$(TELEGRAM_STATE_DIR="$SD_A" python3 "$FALLBACK" "$CHAT" "AGENT_FINAL_ANSWER" --sid "$SID")"
RC_A=$?
assert_eq "helper exit 0 on success" "0" "$RC_A"
assert_eq "helper sent exactly one sendMessage" "1" "$(count sendMessage)"
assert_eq "helper deleted the placeholder (deleteMessage)" "1" "$(count deleteMessage)"
assert_eq "placeholder cleared from pend after helper" "no" "$(pend_has_chat "$SD_A")"

# ---------------------------------------------------------------------------
# (b) FIXED PATH: after the helper cleared the placeholder, the Stop hook does
#     NOT re-deliver (no duplicate) and does NOT nudge (no restart).
# ---------------------------------------------------------------------------
echo ""
echo "(b) After helper: Stop hook produces no duplicate, no nudge"
# First Stop (fresh): pend empty -> no block/nudge decision on stdout.
STOP_FIRST="$(run_stop "$SD_A" false)"
if printf '%s' "$STOP_FIRST" | grep -q '"decision"'; then
    fail "first Stop after clear must NOT block/nudge (would force a restart)"
else
    pass "first Stop after clear allows stop (no nudge, no restart)"
fi
# Second Stop (enforce): still nothing pending -> zero extra sends.
run_stop "$SD_A" true >/dev/null
assert_eq "no duplicate: sendMessage count stays 1 across both Stops" "1" "$(count sendMessage)"

# ---------------------------------------------------------------------------
# (c) CONTROL: the RAW path (placeholder NOT cleared) is exactly what the Stop
#     hook re-delivers -> proves clearing is what prevents the dupe.
# ---------------------------------------------------------------------------
echo ""
echo "(c) Control: un-cleared placeholder -> enforce re-delivers"
SD_C="$TMP/c"; make_state "$SD_C"
: > "$REQLOG"
# Simulate a raw manual send (one message out) WITHOUT clearing the placeholder.
# We don't actually need to send here; we assert the enforce path would send the
# agent's answer because the placeholder is still pending.
assert_eq "control: pend still has the chat" "yes" "$(pend_has_chat "$SD_C")"
run_stop "$SD_C" true >/dev/null   # enforce fallback branch (stop_hook_active)
assert_eq "control: enforce re-delivers the answer (the duplicate)" "1" "$(count sendMessage)"
assert_eq "control: enforce cleared the placeholder afterwards" "no" "$(pend_has_chat "$SD_C")"

# ---------------------------------------------------------------------------
# (d) Helper delivery FAILURE -> exit 2, nothing cleared (caller escalates)
# ---------------------------------------------------------------------------
echo ""
echo "(d) Delivery failure surfaces exit 2, keeps placeholder"
SD_D="$TMP/d"; make_state "$SD_D"
: > "$REQLOG"
# Point at a dead port so sendMessage cannot connect.
DEAD_BASE="http://127.0.0.1:1"
OUT_D="$(TELEGRAM_API_BASE="$DEAD_BASE" TELEGRAM_STATE_DIR="$SD_D" \
    python3 "$FALLBACK" "$CHAT" "text" --sid "$SID" 2>/dev/null)"
RC_D=$?
assert_eq "helper exits 2 when Bot API is unreachable" "2" "$RC_D"
assert_eq "failed send does NOT clear the placeholder" "yes" "$(pend_has_chat "$SD_D")"

# ---------------------------------------------------------------------------
echo ""
echo "============================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
