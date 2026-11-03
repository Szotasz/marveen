#!/bin/bash
# Contract tests: the Telegram fallback senders deliver the answer ONCE per chat.
# Run: bash scripts/__tests__/telegram-fallback-once-per-chat.test.sh
#
# Bug being locked out (FALLBACKEGYSZER1019, 2026-10-19): the submit hook writes
# one pending entry per inbound MESSAGE, so a batched delivery (several
# messages from one chat in one turn) leaves several entries for one chat. The
# Stop hook's guaranteed fallback and the watchdog's backstop sent the answer
# once per ENTRY: 3 messages in -> the same answer 3 times in the chat.
# Measured on develop 16c7d1e3 with this file's stub: 3 sends on both paths.
#
# What is pinned, for the Stop hook (enforce branch) AND the watchdog backstop:
#   1. one chat, three entries        -> ONE sendMessage, three placeholders deleted
#   2. two chats (2 + 1 entries)       -> one sendMessage per chat (positive control:
#                                         the fix must not merge different chats)
#   3. one chat, two topics            -> one sendMessage per topic (a topic is a
#                                         separate conversation)
#   4. the first send fails            -> the next entry of that chat retries it,
#                                         so the answer still arrives exactly once
# and for the watchdog only:
#   5. no recoverable answer           -> every placeholder becomes the error text,
#                                         nothing is sent (unchanged behaviour)
#
# Negative control: point STOP_HOOK_BIN / WATCHDOG_BIN at the pre-fix hooks and
# every send count above fails on both paths (14 of 20: 3 sends where 1 or 2 are
# due, 2 deliveries after a failed send); only the delete counts and case 5 pass.
#
# Hermetic: all Bot API traffic goes to a local stub via TELEGRAM_API_BASE, each
# case has its own state dir, and nothing touches a real Telegram or tmux.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STOP_HOOK="${STOP_HOOK_BIN:-$INSTALL_DIR/scripts/hooks/telegram_progress_clear.py}"
WATCHDOG="${WATCHDOG_BIN:-$INSTALL_DIR/scripts/hooks/telegram_progress_watchdog.py}"

TMP="$(mktemp -d)"
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Bot API stub -----------------------------------------------------
# One line per request ("<method> <body>") to $REQLOG. If $TMP/fail-next-send
# exists, the next sendMessage answers HTTP 500 and the file is removed.
REQLOG="$TMP/requests.log"
PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog, failflag = sys.argv[1], sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        method = self.path.rsplit("/", 1)[-1]
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(f"{method} {body}\n")
        if method == "sendMessage" and os.path.exists(failflag):
            os.remove(failflag)
            self.send_response(500); self.end_headers(); return
        out = {"ok": True, "result": {"message_id": 9001} if method == "sendMessage" else True}
        payload = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[3], "w").write(str(srv.server_port))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$TMP/fail-next-send" "$PORTFILE" &
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null || true   # no "Terminated" line when the trap stops it
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
[ -s "$PORTFILE" ] || { echo "FAIL: the Bot API stub did not start"; exit 1; }
export TELEGRAM_API_BASE="http://127.0.0.1:$(cat "$PORTFILE")"

# A state dir with a token, a transcript whose last assistant text is the answer
# (empty answer -> no assistant text), and a pending file built from ENTRIES:
# one "chat_id:message_id[:thread]" per word.
mkstate() { # name answer entries...
  local sd="$TMP/$1" answer="$2"; shift 2
  mkdir -p "$sd/progress"
  echo "TELEGRAM_BOT_TOKEN=stub-token" > "$sd/.env"
  if [ -n "$answer" ]; then
    printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\n' "$answer" > "$sd/transcript.jsonl"
  else
    : > "$sd/transcript.jsonl"
  fi
  python3 - "$sd" "$@" <<'PYEOF'
import json, os, sys
sd, entries = sys.argv[1], sys.argv[2:]
pend = []
for e in entries:
    parts = e.split(":")
    entry = {"chat_id": parts[0], "message_id": int(parts[1]), "src_mid": parts[1],
             "transcript_path": os.path.join(sd, "transcript.jsonl")}
    if len(parts) > 2:
        entry["message_thread_id"] = int(parts[2])
    pend.append(entry)
json.dump(pend, open(os.path.join(sd, "progress", "sid1.json"), "w"))
PYEOF
  echo "$sd"
}

run_stop() { # state dir -- the enforce branch (stop_hook_active), the guaranteed fallback
  : > "$REQLOG"
  printf '{"session_id":"sid1","transcript_path":"%s","stop_hook_active":true}' "$1/transcript.jsonl" \
    | TELEGRAM_STATE_DIR="$1" python3 "$STOP_HOOK" >/dev/null 2>&1
}

run_watchdog() { # state dir -- the marker is 20 min old: the wedged backstop fires
  : > "$REQLOG"
  python3 - "$1/progress/sid1.json" <<'PYEOF'
import os, sys, time
t = time.time() - 20 * 60
os.utime(sys.argv[1], (t, t))
PYEOF
  python3 - "$WATCHDOG" "$1/progress" <<'PYEOF' >/dev/null 2>&1
import importlib.util, sys
spec = importlib.util.spec_from_file_location("wd", sys.argv[1])
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)
wd.handle_dir(sys.argv[2])
PYEOF
}

count() { grep -c "^$1 " "$REQLOG" 2>/dev/null || true; }
sends_to() { grep "^sendMessage " "$REQLOG" | grep -c "$1" || true; }

for path in stop watchdog; do
  echo "== $path"
  run() { if [ "$path" = stop ]; then run_stop "$1"; else run_watchdog "$1"; fi; }

  sd="$(mkstate "$path-1" "A VALASZ" 42:101 42:102 42:103)"
  run "$sd"
  assert_eq "$path: one chat, three entries -> one send" 1 "$(count sendMessage)"
  assert_eq "$path: one chat, three entries -> all three placeholders deleted" 3 "$(count deleteMessage)"

  sd="$(mkstate "$path-2" "A VALASZ" 42:101 42:102 77:201)"
  run "$sd"
  assert_eq "$path: two chats -> two sends" 2 "$(count sendMessage)"
  assert_eq "$path: two chats -> chat 42 gets it once" 1 "$(sends_to '"chat_id": "42"')"
  assert_eq "$path: two chats -> chat 77 gets it once" 1 "$(sends_to '"chat_id": "77"')"

  sd="$(mkstate "$path-3" "A VALASZ" 42:101:5 42:102:5 42:103:9)"
  run "$sd"
  assert_eq "$path: one chat, two topics -> one send per topic" 2 "$(count sendMessage)"
  assert_eq "$path: topic 5 gets it once" 1 "$(sends_to '"message_thread_id": 5')"

  sd="$(mkstate "$path-4" "A VALASZ" 42:101 42:102 42:103)"
  touch "$TMP/fail-next-send"
  run "$sd"
  assert_eq "$path: first send fails -> retried by the next entry (two attempts)" 2 "$(count sendMessage)"
  # the stub failed exactly one attempt, so the deliveries are attempts - 1
  assert_eq "$path: first send fails -> delivered exactly once" 1 "$(( $(count sendMessage) - 1 ))"
done

echo "== watchdog, no recoverable answer"
sd="$(mkstate "wd-5" "" 42:101 42:102 42:103)"
run_watchdog "$sd"
assert_eq "watchdog: no answer -> nothing sent" 0 "$(count sendMessage)"
assert_eq "watchdog: no answer -> every placeholder becomes the error text" 3 "$(count editMessageText)"

echo
echo "telegram fallback once-per-chat: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
