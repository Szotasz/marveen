#!/bin/bash
# Contract tests for slack_progress_reply_clear.py -- the PostToolUse hook
# that deletes the "Dolgozom rajta…" placeholder the moment the agent's
# Slack `reply` tool fires.
# Run: bash scripts/__tests__/slack-reply-clear.test.sh
#
# Locks the (chat_id, thread_ts) matching contract. A strict thread_ts
# equality here left the placeholder pending whenever the reply's thread
# differed from the inbound block's, and every such miss cascaded into the
# Stop hook blocking, a SECOND agent reply, then the transcript being dumped
# into Slack. Cases:
#   - same thread                  -> cleared
#   - threaded inbound, top-level reply (install rules may require it) -> cleared
#   - thread_ts="" for the optional param                             -> cleared
#   - top-level inbound, reply threaded UNDER it (thread_ts == src_ts) -> cleared
#   - two threads pending in one channel, reply to one -> ONLY that one cleared
#   - threaded + top-level pending, reply to a thread nobody asked in
#       -> only the top-level one cleared (tier 2), the thread keeps its own
#   - reply to a thread nobody asked in, only threads pending -> chat cleared
#   - reply in a different chat -> nothing cleared, state file untouched
#   - non-reply / non-slack tool -> no-op
#
# Fully hermetic: SLACK_STATE_DIR is a temp tree and all Web API traffic is
# routed to a local stub via SLACK_API_BASE.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$INSTALL_DIR/scripts/hooks/slack_progress_reply_clear.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Web API stub (logs "<method> <body>" per request) -----------------
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
        payload = json.dumps({"ok": True}).encode()
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

SID="sess-reply-clear"
CHAT="C0BJTESTCHAN"
OTHER_CHAT="C0BJOTHER"
TOOL="mcp__plugin_slack-channel_slack__reply"
SRC_TS="1757400000.000001"      # the inbound message's own ts
THREAD_A="1757400000.000001"    # inbound written inside thread A (== its root)
THREAD_B="1757400100.000002"
PH_A="1757400001.000100"
PH_B="1757400101.000200"

STATE="$TMP/state"
PROGRESS="$STATE/progress"
STATEFILE="$PROGRESS/$SID.json"

# reset <json-array>  -- fresh state dir with one pending file
reset() {
    rm -rf "$STATE"; mkdir -p "$PROGRESS"
    printf 'SLACK_BOT_TOKEN=xoxb-TESTTOKEN\n' > "$STATE/.env"
    printf '%s' "$1" > "$STATEFILE"
    : > "$REQLOG"
}

# run_hook <tool_name> <tool_input-json>
run_hook() {
    printf '{"session_id":"%s","tool_name":"%s","tool_input":%s}' "$SID" "$1" "$2" \
      | SLACK_STATE_DIR="$STATE" SLACK_API_BASE="$API_BASE" python3 "$HOOK"
}

# deleted_ts -> space-separated list of ts values passed to chat.delete
deleted_ts() {
    grep '^chat.delete ' "$REQLOG" 2>/dev/null \
      | python3 -c 'import sys,json; print(" ".join(json.loads(l.split(" ",1)[1])["ts"] for l in sys.stdin))'
}

# remaining_ts -> space-separated placeholder ts values still pending
remaining_ts() {
    if [ -f "$STATEFILE" ]; then
        python3 -c 'import sys,json; print(" ".join(p["ts"] for p in json.load(open(sys.argv[1]))))' "$STATEFILE"
    else
        echo "(none)"
    fi
}

ENTRY_A='{"chat_id":"'"$CHAT"'","ts":"'"$PH_A"'","thread_ts":"'"$THREAD_A"'","src_ts":"'"$SRC_TS"'"}'
ENTRY_B='{"chat_id":"'"$CHAT"'","ts":"'"$PH_B"'","thread_ts":"'"$THREAD_B"'","src_ts":"1757400150.000003"}'
ENTRY_TOP='{"chat_id":"'"$CHAT"'","ts":"'"$PH_A"'","src_ts":"'"$SRC_TS"'"}'

echo "== same thread: reply carries the inbound thread_ts"
reset "[$ENTRY_A]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":"'"$THREAD_A"'"}'
assert_eq "placeholder deleted"  "$PH_A"   "$(deleted_ts)"
assert_eq "state file removed"   "(none)"  "$(remaining_ts)"

echo "== threaded inbound, TOP-LEVEL reply (no thread_ts at all)"
reset "[$ENTRY_A]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "placeholder deleted"  "$PH_A"   "$(deleted_ts)"
assert_eq "state file removed"   "(none)"  "$(remaining_ts)"

echo "== threaded inbound, reply passes thread_ts=\"\""
reset "[$ENTRY_A]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":""}'
assert_eq "placeholder deleted"  "$PH_A"   "$(deleted_ts)"
assert_eq "state file removed"   "(none)"  "$(remaining_ts)"

echo "== top-level inbound, reply threaded UNDER it (thread_ts == inbound ts)"
reset "[$ENTRY_TOP]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":"'"$SRC_TS"'"}'
assert_eq "placeholder deleted"  "$PH_A"   "$(deleted_ts)"
assert_eq "state file removed"   "(none)"  "$(remaining_ts)"

echo "== top-level inbound, thread_ts=\"\" reply"
reset "[$ENTRY_TOP]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":""}'
assert_eq "placeholder deleted"  "$PH_A"   "$(deleted_ts)"
assert_eq "state file removed"   "(none)"  "$(remaining_ts)"

echo "== two threads pending in one channel, reply into thread B only"
reset "[$ENTRY_A,$ENTRY_B]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":"'"$THREAD_B"'"}'
assert_eq "only B's placeholder deleted" "$PH_B" "$(deleted_ts)"
assert_eq "A still pending"              "$PH_A" "$(remaining_ts)"

echo "== two threads pending, top-level reply clears both (the chat got its answer)"
reset "[$ENTRY_A,$ENTRY_B]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "both placeholders deleted" "$PH_A $PH_B" "$(deleted_ts)"
assert_eq "state file removed"        "(none)"      "$(remaining_ts)"

echo "== threaded A + top-level pending, reply into a thread nobody asked in -> only top-level cleared"
reset "[$ENTRY_A,{\"chat_id\":\"$CHAT\",\"ts\":\"$PH_B\",\"src_ts\":\"1757400150.000003\"}]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":"1757409999.000009"}'
assert_eq "only the top-level placeholder deleted" "$PH_B" "$(deleted_ts)"
assert_eq "A still pending"                        "$PH_A" "$(remaining_ts)"

echo "== reply into a thread nobody asked in, only threads pending -> chat-level fallback clears the chat"
reset "[$ENTRY_A]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":"1757409999.000009"}'
assert_eq "placeholder deleted"  "$PH_A"   "$(deleted_ts)"
assert_eq "state file removed"   "(none)"  "$(remaining_ts)"

echo "== reply in a DIFFERENT chat -> untouched"
reset "[$ENTRY_A]"
run_hook "$TOOL" '{"chat_id":"'"$OTHER_CHAT"'","text":"kesz"}'
assert_eq "nothing deleted"      ""        "$(deleted_ts)"
assert_eq "A still pending"      "$PH_A"   "$(remaining_ts)"

echo "== mixed chats: reply in one chat leaves the other chat's entry alone"
reset "[$ENTRY_A,{\"chat_id\":\"$OTHER_CHAT\",\"ts\":\"$PH_B\"}]"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "only this chat's placeholder deleted" "$PH_A" "$(deleted_ts)"
assert_eq "other chat still pending"             "$PH_B" "$(remaining_ts)"

echo "== legacy entry without src_ts (pre-upgrade state file) still clears"
reset '[{"chat_id":"'"$CHAT"'","ts":"'"$PH_A"'","thread_ts":"'"$THREAD_A"'"}]'
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "placeholder deleted"  "$PH_A"   "$(deleted_ts)"
assert_eq "state file removed"   "(none)"  "$(remaining_ts)"

echo "== non-reply slack tool -> no-op"
reset "[$ENTRY_A]"
run_hook "mcp__plugin_slack-channel_slack__react" '{"chat_id":"'"$CHAT"'","emoji":"eyes"}'
assert_eq "nothing deleted"      ""        "$(deleted_ts)"
assert_eq "A still pending"      "$PH_A"   "$(remaining_ts)"

echo "== telegram reply tool -> no-op"
reset "[$ENTRY_A]"
run_hook "mcp__plugin_telegram_telegram__reply" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "nothing deleted"      ""        "$(deleted_ts)"
assert_eq "A still pending"      "$PH_A"   "$(remaining_ts)"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
