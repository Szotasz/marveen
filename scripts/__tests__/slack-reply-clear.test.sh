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
# and the failed-delete contract (review #4), through the stub's failure
# injection (stub_mode):
#   - chat.delete RETRYABLE (HTTP 429/503, ok:false ratelimited, API down)
#       -> entry KEPT, marked "replied": true; a partial failure keeps only
#          the failed entry
#   - chat.delete TERMINAL (message_not_found) -> entry dropped, error logged
#   - a replied leftover is retried by the next reply to the chat, and never
#     shadows a live placeholder in the tier matching
#   - Stop hook (slack_progress_clear.py): a replied entry never blocks the
#     turn; its delete is retried, a second retryable failure leaves it for
#     the watchdog; next to an unanswered entry only the unanswered one is
#     enforced
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
# Failure injection, same as slack-watchdog-wedged.test.sh: MODEFILE holds lines
# "<method|*> <mode> [count]" with mode = ok | ok_false:<error> | http:<status>.
# The first matching line answers a request; a line with a count is consumed by
# that many requests and then skipped. No file / no match = {"ok": true}. Slack
# reports application errors as HTTP 200 + {"ok": false, "error": ...}: a stub
# that can only say ok:true left this suite blind to every failed chat.delete.
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"; MODEFILE="$TMP/stub-mode"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog, portfile, modefile = sys.argv[1:4]
def pick_mode(method):
    try:
        lines = [l.split() for l in open(modefile, encoding="utf-8").read().splitlines() if l.strip()]
    except Exception:
        return "ok"
    mode, chosen, rest = "ok", False, []
    for parts in lines:
        m, md = parts[0], parts[1]
        n = int(parts[2]) if len(parts) > 2 else None
        if not chosen and m in ("*", method) and (n is None or n > 0):
            mode, chosen = md, True
            if n is not None:
                n -= 1
        rest.append(" ".join([m, md] + ([str(n)] if n is not None else [])))
    if chosen:
        with open(modefile, "w", encoding="utf-8") as f:
            f.write("\n".join(rest) + "\n")
    return mode
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]
        mode = pick_mode(method)
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        status, out = 200, {"ok": True}
        if mode.startswith("ok_false:"):
            out = {"ok": False, "error": mode.split(":", 1)[1]}
        elif mode.startswith("http:"):
            status = int(mode.split(":", 1)[1])
            out = {"ok": False, "error": f"http_{status}"}
        payload = json.dumps(out).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
with open(portfile, "w") as f: f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" "$MODEFILE" &
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

# -----------------------------------------------------------------------------
# A failed chat.delete is not a cleared placeholder (review #4).
# The entry used to leave the pending file whatever chat.delete said -- the
# exception was swallowed and Slack's HTTP-200 {"ok": false} never looked at --
# so the placeholder stayed in Slack while nothing knew about it any more. A
# RETRYABLE failure now keeps the entry, marked "replied": the answer went out,
# only the cleanup is owed. The mark is the point: an UNMARKED leftover would
# read as "no reply was sent" to the Stop hook and provoke a duplicate reply.
# -----------------------------------------------------------------------------
STOP_HOOK="$INSTALL_DIR/scripts/hooks/slack_progress_clear.py"
stub_mode() { : > "$MODEFILE"; local l; for l in "$@"; do printf '%s\n' "$l" >> "$MODEFILE"; done; }
# replied_ts -> ts values of the pending entries that carry "replied": true
replied_ts() {
    if [ -f "$STATEFILE" ]; then
        python3 -c 'import sys,json; print(" ".join(p["ts"] for p in json.load(open(sys.argv[1])) if p.get("replied")))' "$STATEFILE"
    else
        echo ""
    fi
}
log_has() { grep -q "$1" "$PROGRESS/debug.log" 2>/dev/null && echo yes || echo no; }
# run_stop [stop_hook_active]  -> prints the Stop hook's stdout (the block decision, if any)
run_stop() {
    printf '{"session_id":"%s","stop_hook_active":%s}' "$SID" "${1:-false}" \
      | SLACK_STATE_DIR="$STATE" SLACK_API_BASE="$API_BASE" python3 "$STOP_HOOK"
}

echo "== chat.delete HTTP 429 (RETRYABLE) -> entry KEPT, marked replied"
reset "[$ENTRY_A]"
stub_mode "chat.delete http:429"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz","thread_ts":"'"$THREAD_A"'"}'
assert_eq "429: the delete was attempted"            "$PH_A"  "$(deleted_ts)"
assert_eq "429: entry still in the pending file"     "$PH_A"  "$(remaining_ts)"
assert_eq "429: and it is marked replied"            "$PH_A"  "$(replied_ts)"
assert_eq "429: the failure is in debug.log"         "yes"    "$(log_has "kept as replied")"
stub_mode

echo "== chat.delete HTTP-200 {ok:false, ratelimited} (RETRYABLE) -> kept, replied"
reset "[$ENTRY_A]"
stub_mode "chat.delete ok_false:ratelimited"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "ratelimited: entry kept"                  "$PH_A"  "$(remaining_ts)"
assert_eq "ratelimited: marked replied"              "$PH_A"  "$(replied_ts)"
stub_mode

echo "== chat.delete HTTP 503 / API unreachable (RETRYABLE) -> kept, replied"
reset "[$ENTRY_A]"
stub_mode "chat.delete http:503"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "503: entry kept, marked replied"          "$PH_A"  "$(replied_ts)"
stub_mode
reset "[$ENTRY_A]"
DEAD_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
printf '{"session_id":"%s","tool_name":"%s","tool_input":{"chat_id":"%s","text":"kesz"}}' "$SID" "$TOOL" "$CHAT" \
  | SLACK_STATE_DIR="$STATE" SLACK_API_BASE="http://127.0.0.1:$DEAD_PORT" python3 "$HOOK"
assert_eq "dead API: entry kept, marked replied"     "$PH_A"  "$(replied_ts)"

echo "== chat.delete TERMINAL rejection (message_not_found) -> dropped, waiting cannot help"
reset "[$ENTRY_A]"
stub_mode "chat.delete ok_false:message_not_found"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "terminal: the delete was attempted"       "$PH_A"  "$(deleted_ts)"
assert_eq "terminal: state file removed"             "(none)" "$(remaining_ts)"
assert_eq "terminal: the Slack error is in debug.log" "yes"   "$(log_has "message_not_found")"
stub_mode

echo "== two placeholders cleared by one reply, only the FIRST delete fails -> only that one stays"
reset "[$ENTRY_A,$ENTRY_B]"
stub_mode "chat.delete http:429 1"
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "partial: both deletes attempted"          "$PH_A $PH_B" "$(deleted_ts)"
assert_eq "partial: only the failed entry remains"   "$PH_A"  "$(remaining_ts)"
assert_eq "partial: and it is marked replied"        "$PH_A"  "$(replied_ts)"
stub_mode

echo "== the next reply to the chat retries a replied leftover"
reset '[{"chat_id":"'"$CHAT"'","ts":"'"$PH_A"'","thread_ts":"'"$THREAD_A"'","replied":true}]'
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"meg egy","thread_ts":"1757409999.000009"}'
assert_eq "leftover: delete retried"                 "$PH_A"  "$(deleted_ts)"
assert_eq "leftover: state file removed"             "(none)" "$(remaining_ts)"

echo "== a replied leftover never shadows a LIVE placeholder in the tier matching"
# Leftover: top-level, answered in an earlier turn. Live: asked in thread B.
# A top-level reply is an EXACT match for the leftover; if the leftover took
# part in the tiers it would win alone, the live placeholder would stay
# pending, and the Stop hook would block on an answered message.
reset '[{"chat_id":"'"$CHAT"'","ts":"'"$PH_A"'","replied":true},'"$ENTRY_B"']'
run_hook "$TOOL" '{"chat_id":"'"$CHAT"'","text":"kesz"}'
assert_eq "no shadowing: the live placeholder is cleared (and the leftover retried)" "$PH_B $PH_A" "$(deleted_ts)"
assert_eq "no shadowing: state file removed"         "(none)" "$(remaining_ts)"

echo "== Stop hook: a replied entry NEVER blocks the turn -- its delete is just retried"
reset '[{"chat_id":"'"$CHAT"'","ts":"'"$PH_A"'","thread_ts":"'"$THREAD_A"'","replied":true}]'
OUT_STOP="$(run_stop)"
assert_eq "stop/replied: no block decision on stdout" ""       "$OUT_STOP"
assert_eq "stop/replied: delete retried"              "$PH_A"  "$(deleted_ts)"
assert_eq "stop/replied: nothing posted"              "0"      "$(grep -c '^chat.postMessage ' "$REQLOG")"
assert_eq "stop/replied: state file removed"          "(none)" "$(remaining_ts)"

echo "== Stop hook: the retry fails again (429) -> still no block, entry left for the watchdog"
reset '[{"chat_id":"'"$CHAT"'","ts":"'"$PH_A"'","thread_ts":"'"$THREAD_A"'","replied":true}]'
stub_mode "chat.delete http:429"
OUT_STOP="$(run_stop)"
assert_eq "stop/429: no block decision on stdout"     ""       "$OUT_STOP"
assert_eq "stop/429: entry kept, still marked replied" "$PH_A" "$(replied_ts)"
stub_mode

echo "== Stop hook: a replied leftover next to an UNANSWERED entry -> enforcement sees only the unanswered one"
reset '[{"chat_id":"'"$OTHER_CHAT"'","ts":"'"$PH_A"'","replied":true},'"$ENTRY_B"']'
OUT_STOP="$(run_stop)"
assert_eq "stop/mixed: blocks (the unanswered entry)" "yes" \
  "$(printf '%s' "$OUT_STOP" | grep -q '"decision": "block"' && echo yes || echo no)"
assert_eq "stop/mixed: the block names the unanswered chat only" "no" \
  "$(printf '%s' "$OUT_STOP" | grep -q "$OTHER_CHAT" && echo yes || echo no)"
assert_eq "stop/mixed: the blocking Stop touches nothing" "$PH_A $PH_B" "$(remaining_ts)"
: > "$REQLOG"
OUT_STOP="$(run_stop true)"
assert_eq "stop/mixed 2nd: no second block"           ""       "$OUT_STOP"
assert_eq "stop/mixed 2nd: both placeholders deleted" "$PH_B $PH_A" "$(deleted_ts)"
assert_eq "stop/mixed 2nd: state file removed"        "(none)" "$(remaining_ts)"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
