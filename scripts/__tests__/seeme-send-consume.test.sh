#!/bin/bash
# scripts/sms/seeme-send.py: one approval = one SMS (APPROVALCONSUME1022).
# Before this, check_approval only read status=approved, so the same approval id
# could send any number of messages. Now the script consumes the approval
# (POST /api/approvals/<id>/consume) right before the send and sends only on 200.
#
# Hermetic: a fake dashboard and a fake SeeMe gateway run on a free loopback port
# in a throwaway dir; the real store/ is never read or written. Every request the
# fakes see is appended to one ordered log, so the test can tell WHICH calls went
# out and in WHAT order.
#
# The last section re-runs the replay case on a copy with the consume call removed
# and expects the test to catch it (two SMS for one approval).
#
# Run: bash scripts/__tests__/seeme-send-consume.test.sh
set -u
INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/sms/seeme-send.py"

FAILED=0
pass(){ echo "  PASS  $*"; }
fail(){ echo "  FAIL  $*"; FAILED=1; }

FIX="$(mktemp -d "${TMPDIR:-/tmp}/seeme-consume-XXXX")"
SERVER_PID=""
cleanup(){ [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$FIX"; }
trap cleanup EXIT

EXT="36301234567"
APPROVAL="appr-ext-1"
REQLOG="$FIX/requests.log"
: > "$REQLOG"

# The fake: GET /api/approvals/<id> answers an approved external_message row naming
# $EXT; POST .../consume says 200 once per id, then 409 already_consumed (the real
# conditional write, in miniature); /gateway answers a SeeMe success. "gone-404"
# is an unknown approval for the consume step only.
cat > "$FIX/fake.py" <<'PY'
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
log_path, port_file, ext = sys.argv[1], sys.argv[2], sys.argv[3]
consumed = set()
lock = threading.Lock()
def note(line):
    with lock, open(log_path, "a") as fh:
        fh.write(line + "\n")
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def send_json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith("/gateway"):
            note("GATEWAY " + self.path.split("number=")[1].split("&")[0])
            return self.send_json(200, {"code": "0", "result": "OK", "split": 1, "price": 1})
        aid = self.path.rsplit("/", 1)[1]
        note("GET " + aid)
        return self.send_json(200, {"id": aid, "status": "approved", "category": "external_message",
                                    "content_hash": None, "action_description": f"SMS a {ext} szamra"})
    def do_POST(self):
        aid = self.path.split("/")[3]
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        note(f"CONSUME {aid} category={body.get('category')} consumer={body.get('consumer')} hash={body.get('content_hash')}")
        if aid == "gone-404":
            return self.send_json(404, {"ok": False, "reason": "not_found"})
        with lock:
            first = aid not in consumed
            consumed.add(aid)
        if first:
            return self.send_json(200, {"ok": True, "approval": {"id": aid}})
        return self.send_json(409, {"ok": False, "reason": "already_consumed"})
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(port_file, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
python3 "$FIX/fake.py" "$REQLOG" "$FIX/port" "$EXT" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$FIX/port" ] && break; sleep 0.1; done
PORT="$(cat "$FIX/port" 2>/dev/null)"
if [ -z "$PORT" ]; then echo "SKIP (control unmet): the fake server did not start"; exit 77; fi

export SEEME_INTERNAL_FILE="$FIX/internal.json"
export SEEME_DASH_TOKEN_FILE="$FIX/.dashboard-token"
export SEEME_ENV_FILE="$FIX/seeme-gateway.env"
export SEEME_LOG_FILE="$FIX/seeme-send.log"
export SEEME_DASH_BASE="http://127.0.0.1:$PORT"
printf '{"internal": ["36305552860"]}' > "$SEEME_INTERNAL_FILE"
printf 'teszt-fixture-token-nem-valodi' > "$SEEME_DASH_TOKEN_FILE"
printf 'SEEME_API_KEY=fake\nSEEME_SENDER=36300000000\nSEEME_BASE=http://127.0.0.1:%s/gateway\n' "$PORT" > "$SEEME_ENV_FILE"

send(){ # send <script> <approval> [--dry-run]
  printf '%s' "teszt uzenet" | python3 "$1" --to "$EXT" --approval "$2" ${3:-} 2>&1
}
count(){ grep -c "$1" "$REQLOG"; }

echo "--- dry-run never consumes ---"
: > "$REQLOG"
out="$(send "$SCRIPT" "$APPROVAL" --dry-run)"; rc=$?
[ $rc -eq 0 ] && [ "$(count '^CONSUME')" -eq 0 ] && [ "$(count '^GATEWAY')" -eq 0 ] \
  && pass "dry-run: exit 0, no consume, no send" \
  || fail "dry-run must neither consume nor send (rc=$rc): $(cat "$REQLOG") $out"

echo "--- first send: consume, then the gateway ---"
: > "$REQLOG"
out="$(send "$SCRIPT" "$APPROVAL")"; rc=$?
order="$(grep -E '^(CONSUME|GATEWAY)' "$REQLOG" | cut -d' ' -f1 | tr '\n' ' ')"
[ $rc -eq 0 ] && [ "$order" = "CONSUME GATEWAY " ] \
  && pass "exit 0, exactly one consume and then one send" \
  || fail "expected 'CONSUME GATEWAY', got '$order' (rc=$rc): $out"
grep -q "^CONSUME $APPROVAL category=external_message consumer=seeme-send.py hash=None$" "$REQLOG" \
  && pass "the consume names the category, the tool and the approval's own anchor" \
  || fail "consume body not as expected: $(grep '^CONSUME' "$REQLOG")"

echo "--- replay with the same approval: refused, nothing sent ---"
: > "$REQLOG"
out="$(send "$SCRIPT" "$APPROVAL")"; rc=$?
[ $rc -ne 0 ] && [ "$(count '^GATEWAY')" -eq 0 ] && echo "$out" | grep -q "already_consumed" \
  && pass "second send: exit $rc, already_consumed, the gateway was not called" \
  || fail "second send must be refused without a send (rc=$rc): $(cat "$REQLOG") $out"

echo "--- consume 404: no send ---"
: > "$REQLOG"
out="$(send "$SCRIPT" "gone-404")"; rc=$?
[ $rc -ne 0 ] && [ "$(count '^GATEWAY')" -eq 0 ] \
  && pass "unknown approval at consume: exit $rc, nothing sent" \
  || fail "consume 404 must not send (rc=$rc): $(cat "$REQLOG") $out"

echo "--- dashboard unreachable at consume: no send ---"
: > "$REQLOG"
DEAD="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
out="$(SEEME_DASH_BASE="http://127.0.0.1:$DEAD" send "$SCRIPT" "appr-ext-2")"; rc=$?
[ $rc -ne 0 ] && [ "$(count '^GATEWAY')" -eq 0 ] \
  && pass "no dashboard: exit $rc, nothing sent" \
  || fail "an unreachable dashboard must not send (rc=$rc): $out"

echo "--- internal recipient: nothing to consume ---"
: > "$REQLOG"
out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to 36305552860 2>&1)"; rc=$?
[ $rc -eq 0 ] && [ "$(count '^CONSUME')" -eq 0 ] && [ "$(count '^GATEWAY')" -eq 1 ] \
  && pass "internal number: sent once, no consume call" \
  || fail "internal send must not consume (rc=$rc): $(cat "$REQLOG") $out"

echo "--- the refusal without --approval prints a recipe that exists ---"
out="$(printf '%s' "teszt" | python3 "$SCRIPT" --to "$EXT" --dry-run 2>&1)"
json_line="$(echo "$out" | grep -E '^ *\{"agent_id"')"
if echo "$out" | grep -q "approval-request.sh"; then
  fail "the refusal still names scripts/approval-request.sh, which does not exist"
elif echo "$out" | grep -q "/api/approvals" && printf '%s' "$json_line" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["category"]=="external_message" and "'"$EXT"'" in d["action_description"]'; then
  pass "the refusal prints POST /api/approvals with a valid external_message payload naming the number"
else
  fail "the refusal recipe is missing or its payload is not valid JSON: $out"
fi

echo "--- mutation control: without the consume call the replay sends twice ---"
MUT="$FIX/seeme-send-mutated.py"
sed 's/^        consume_approval(args.approval, rec, reference)$/        pass/' "$SCRIPT" > "$MUT"
if diff -q "$SCRIPT" "$MUT" >/dev/null 2>&1; then
  fail "the sed pattern matched nothing: the mutation did not change the file"
else
  : > "$REQLOG"
  send "$MUT" "appr-ext-3" >/dev/null; send "$MUT" "appr-ext-3" >/dev/null
  [ "$(count '^GATEWAY')" -eq 2 ] \
    && pass "mutated copy sends twice for one approval: the replay case above can fail" \
    || fail "the mutation did not change the behaviour ($(count '^GATEWAY') sends): the replay case does not measure the consume"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "OSSZES PASS"
  exit 0
else
  echo "VAN BUKOTT TESZT"
  exit 1
fi
