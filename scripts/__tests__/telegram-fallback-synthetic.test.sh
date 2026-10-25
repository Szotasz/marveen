#!/bin/bash
# Contract tests: a CLI-written last line never goes out as the agent's reply, and a real
# fallback send leaves one ledger row, written after the pending state is gone (#2269).
# Run: bash scripts/__tests__/telegram-fallback-synthetic.test.sh
#
# The CLI writes its own lines into the transcript as assistant messages (a session/usage-limit
# wall, an API error, "No response requested."). Both fallback senders, the Stop hook's
# guaranteed fallback (enforce branch) and the watchdog's wedged backstop, used to send such a
# line to the chat as if it were the answer.
#
# What is pinned, on BOTH paths:
#   (a) isApiErrorMessage / model "<synthetic>" with "You've hit your session limit"
#         -> the placeholder is edited to the outage text, no sendMessage, no delete, no ledger row
#   (b) model "<synthetic>" with "No response requested."
#         -> nothing is sent and no outage edit (the turn has no answer)
#   (c) a real model id whose genuine reply starts with "API error"
#         -> it IS sent (no false positive), and exactly one outbound ledger row with the
#            path's prefix, written only after the pending entry / marker is removed
#
# Negative controls (run by hand against mutated copies of the two hooks when this file was
# written): a synthetic detection that always says "not synthetic" fails 12 checks, (a) and (b) on
# both paths; removing the ledger_log_out calls fails the three ledger checks of (c) on both paths.
# The ordering check records, at the moment of the ledger write, whether the pending entry or
# marker still exists.
#
# Hermetic: Bot API traffic goes to a local stub (TELEGRAM_API_BASE), the ledger is a sandbox
# SQLite file (LEDGER_DB_PATH), each case has its own state dir, nothing touches tmux.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STOP_HOOK="${STOP_HOOK_BIN:-$INSTALL_DIR/scripts/hooks/telegram_progress_clear.py}"
WATCHDOG="${WATCHDOG_BIN:-$INSTALL_DIR/scripts/hooks/telegram_progress_watchdog.py}"
export MARVEEN_ROOT="$INSTALL_DIR"

TMP="$(mktemp -d)"
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

REQLOG="$TMP/requests.log"
PORTFILE="$TMP/port"
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
        out = {"ok": True, "result": {"message_id": 9001} if method == "sendMessage" else True}
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[2], "w").write(str(srv.server_port))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
[ -s "$PORTFILE" ] || { echo "FAIL: the Bot API stub did not start"; exit 1; }
export TELEGRAM_API_BASE="http://127.0.0.1:$(cat "$PORTFILE")"

# The three transcript fixtures: one assistant line each.
LINE_LIMIT='{"type":"assistant","isApiErrorMessage":true,"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"You'"'"'ve hit your session limit · resets 12am (UTC)"}]}}'
LINE_NORESP='{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}'
LINE_REAL='{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"API error 429 means the upstream rate limit; retry after the reset."}]}}'

# State dir: token, a transcript holding LINE, one pending entry for chat 111 / message 5,
# both files 20 minutes old (so the watchdog's backstop fires), and an empty sandbox ledger.
mkstate() { # name line
  local sd="$TMP/$1"
  mkdir -p "$sd/progress"
  echo "TELEGRAM_BOT_TOKEN=stub-token" > "$sd/.env"
  printf '%s\n' "$2" > "$sd/transcript.jsonl"
  python3 - "$sd" <<'PYEOF'
import json, os, sqlite3, sys, time
sd = sys.argv[1]
p = os.path.join(sd, "progress", "sid1.json")
json.dump([{"chat_id": "111", "message_id": 5, "src_mid": "5",
            "transcript_path": os.path.join(sd, "transcript.jsonl")}], open(p, "w"))
t = time.time() - 20 * 60
for f in (p, os.path.join(sd, "transcript.jsonl")):
    os.utime(f, (t, t))
sqlite3.connect(os.path.join(sd, "ledger.db")).close()
PYEOF
  echo "$sd"
}

# Both runners load the hook as a module and wrap its ledger_log_out, so the test can see
# whether the pending file / marker still existed at the moment of the ledger write.
run_stop() { # state dir
  : > "$REQLOG"
  printf '{"session_id":"sid1","transcript_path":"%s","stop_hook_active":true}' "$1/transcript.jsonl" \
    | TELEGRAM_STATE_DIR="$1" LEDGER_DB_PATH="$1/ledger.db" python3 "$TMP/run_stop.py" "$STOP_HOOK" "$1" >/dev/null 2>&1
}

# The Stop-hook runner lives in a file: its stdin is the hook payload.
cat > "$TMP/run_stop.py" <<'PYEOF'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("clear", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
sd = sys.argv[2]
orig = m.ledger_log_out
def wrapped(*a, **k):
    with open(os.path.join(sd, "ledger-order"), "a") as f:
        f.write("pending-present\n" if os.path.exists(os.path.join(sd, "progress", "sid1.json")) else "pending-gone\n")
    return orig(*a, **k)
m.ledger_log_out = wrapped
m.main()
PYEOF

run_watchdog() { # state dir
  : > "$REQLOG"
  LEDGER_DB_PATH="$1/ledger.db" python3 - "$WATCHDOG" "$1" <<'PYEOF' >/dev/null 2>&1
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("wd", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
sd = sys.argv[2]
orig = m.ledger_log_out
def wrapped(*a, **k):
    with open(os.path.join(sd, "ledger-order"), "a") as f:
        f.write("pending-present\n" if os.path.exists(os.path.join(sd, "progress", "sid1.json")) else "pending-gone\n")
    return orig(*a, **k)
m.ledger_log_out = wrapped
m.handle_dir(os.path.join(sd, "progress"))
PYEOF
}

count() { grep -c "^$1 " "$REQLOG" 2>/dev/null || true; }
outage_edits() { # editMessageText calls whose (JSON-decoded) text is the outage text
  python3 - "$REQLOG" <<'PYEOF'
import json, sys
n = 0
for line in open(sys.argv[1], encoding="utf-8"):
    method, _, body = line.rstrip("\n").partition(" ")
    if method == "editMessageText":
        try:
            n += "átmeneti kiesés" in json.loads(body).get("text", "")
        except Exception:
            pass
print(n)
PYEOF
}
ledger_rows() { # db prefix -> count of outbound rows whose text starts with the prefix
  python3 - "$1" "$2" <<'PYEOF'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
try:
    rows = con.execute("SELECT text FROM conversation_log WHERE direction='out'").fetchall()
except sqlite3.OperationalError:
    rows = []
print(sum(1 for (t,) in rows if t.startswith(sys.argv[2])))
PYEOF
}
ledger_all() { ledger_rows "$1" ""; }

for path in stop watchdog; do
  echo "== $path"
  if [ "$path" = stop ]; then PREFIX="[telegram-progress-clear, fallback]"; else PREFIX="[telegram-progress-watchdog]"; fi
  run() { if [ "$path" = stop ]; then run_stop "$1"; else run_watchdog "$1"; fi; }

  sd="$(mkstate "$path-a" "$LINE_LIMIT")"; run "$sd"
  assert_eq "$path (a) limit line: no sendMessage" "0" "$(count sendMessage)"
  assert_eq "$path (a) limit line: placeholder edited to the outage text" "1" "$(outage_edits)"
  assert_eq "$path (a) limit line: placeholder stays (no delete)" "0" "$(count deleteMessage)"
  assert_eq "$path (a) limit line: no ledger row" "0" "$(ledger_all "$sd/ledger.db")"

  sd="$(mkstate "$path-b" "$LINE_NORESP")"; run "$sd"
  assert_eq "$path (b) 'No response requested.': no sendMessage" "0" "$(count sendMessage)"
  assert_eq "$path (b) 'No response requested.': no outage edit" "0" "$(outage_edits)"
  assert_eq "$path (b) 'No response requested.': no ledger row" "0" "$(ledger_all "$sd/ledger.db")"

  sd="$(mkstate "$path-c" "$LINE_REAL")"; run "$sd"
  assert_eq "$path (c) real reply starting 'API error': sent once" "1" "$(count sendMessage)"
  assert_eq "$path (c) real reply: the sent text is the reply" "1" "$(grep '^sendMessage ' "$REQLOG" | grep -c 'upstream rate limit' || true)"
  assert_eq "$path (c) real reply: no outage edit" "0" "$(outage_edits)"
  assert_eq "$path (c) real reply: one outbound ledger row" "1" "$(ledger_all "$sd/ledger.db")"
  assert_eq "$path (c) real reply: the row carries the path's prefix" "1" "$(ledger_rows "$sd/ledger.db" "$PREFIX")"
  assert_eq "$path (c) real reply: ledger written after the pending state is gone" "pending-gone" "$(cat "$sd/ledger-order" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
done

echo
echo "telegram fallback synthetic + ledger: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
