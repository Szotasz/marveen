#!/bin/bash
# Contract tests for the morning briefing's same-day dedup stamp.
# Run: bash scripts/__tests__/morning-stamp-gate.test.sh
#
# Bug being locked out (observed 2026-09-13): the stamp recorded "the process
# exited 0", not "the owner got the briefing". The 07:27 run refused its own
# task (its config dir carried no channel allowlist, so the reply tool rejected
# the owner's chat_id), printed an explanation, exited 0 -- and stamped the day
# as delivered. The guard then suppressed every retry and the owner got nothing.
#
# Fix under test: the run must print the per-run sentinel on its own line,
# which it is told to do ONLY after a reply tool call actually succeeded. No
# sentinel means no stamp, so the next trigger tries again. The sentinel
# carries a per-run nonce (MORNTIMERPARK914): a fixed constant is a control
# trigger that matches its own instruction text, so a run that merely QUOTES
# the instruction on a bare line would stamp an undelivered day.
#
# MORNINGPOLLER1770: the script now delivers the text itself through the Bot API
# (the model call has no channel plugin), so "stamped" also needs every chunk to
# come back ok:true. All Bot API traffic goes to a local stub (TELEGRAM_API_BASE);
# a token containing "fail" makes the stub answer {"ok":false}.
#
# Hermetic: `claude` is a stub on PATH, and the script runs against a throwaway
# INSTALL_DIR, so nothing is sent and the real store/ is untouched. The stub
# extracts the actual sentinel from the prompt it receives -- the tests must
# not know the nonce in advance, exactly like a real run.

set -u

# Hermetic (#1555 review round 1): inside an agent session the inherited
# channel state dir points at a live access.json / bot token.
unset TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"

TODAY="$(date +%F)"

# --- Local Bot API stub (telegram-fallback-dedup.test.sh pattern) -----------
# One JSON line per request to $REQLOG: {"token","method","chat_id","text"}.
REQLOG="$TMP/requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, HTTPServer
reqlog = sys.argv[1]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        _, tok, method = self.path.split("/", 2)
        tok = tok[3:]
        q = {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}
        with open(reqlog, "a", encoding="utf-8") as f:
            f.write(json.dumps({"token": tok, "method": method, "chat_id": q.get("chat_id"), "text": q.get("text")}, ensure_ascii=False) + "\n")
        out = {"ok": False, "description": "stub: forced failure"} if "fail" in tok else {"ok": True, "result": {"message_id": 1}}
        # Compact like the real Bot API: send-telegram.sh matches the literal "ok":true.
        payload = json.dumps(out, separators=(",", ":")).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[2], "w").write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null  # no "Terminated" job line when the trap kills it
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
[ -s "$PORTFILE" ] || { echo "FATAL: Bot API stub did not start"; exit 1; }
export TELEGRAM_API_BASE="http://127.0.0.1:$(cat "$PORTFILE")"

# Builds a throwaway install with a `claude` stub, runs the briefing, and
# echoes the resulting stamp content ("<none>" if unstamped).
#   $1: stub mode -- what the fake run prints:
#       success       the real sentinel (parsed from the prompt) on its own line
#       refuse        an explanation, no sentinel anywhere
#       substring     the real sentinel embedded inside a longer line
#       old_constant  the bare pre-nonce constant "MORNING_SENT_OK"
#   $2: stub exit code
#   $3: ALLOWED_CHAT_ID value in the throwaway .env (default 1234)
#   $4: 1 to also seed telegram/access.json with an allowFrom entry (5555)
#   $5: bot token in the install .env ("tok-ok"; one containing "fail" makes
#       the Bot API stub refuse; "-" leaves it out of the .env)
run_case() {
  local mode="$1" stub_rc="$2" chat_id="${3:-1234}" with_access="${4:-0}" tok="${5:-tok-ok}"
  local dir="$TMP/inst.$RANDOM"
  mkdir -p "$dir/scripts/lib" "$dir/store" "$dir/bin"
  cp "$REPO/scripts/morning-briefing.sh" "$dir/scripts/"
  cp "$REPO/scripts/lib/owner-chat.sh" "$REPO/scripts/lib/send-telegram.sh" "$dir/scripts/lib/"
  printf 'ALLOWED_CHAT_ID=%s\n' "$chat_id" > "$dir/.env"
  [ "$tok" = "-" ] || printf 'TELEGRAM_BOT_TOKEN=%s\n' "$tok" >> "$dir/.env"
  if [ "$with_access" = "1" ]; then
    mkdir -p "$dir/.claude/channels/telegram"
    printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
    printf '{"allowFrom":["5555"]}\n' > "$dir/.claude/channels/telegram/access.json"
  fi
  # The stub sees the same argv a real claude would, so it recovers the
  # sentinel the same way an obedient run does: from the prompt text.
  cat > "$dir/bin/claude" <<STUB
#!/bin/bash
S="\$(printf '%s\n' "\$@" | grep -o 'MORNING_SENT_OK_[0-9]*_[0-9]*' | head -1)"
case "$mode" in
  success)      echo "Reggeli napindito: 3 level, 2 esemeny."; echo "\$S" ;;
  long)         for i in \$(seq 1 300); do echo "sor \$i: \$(printf 'x%.0s' \$(seq 1 30))"; done; echo "\$S" ;;
  notlast)      echo "\$S"; echo "Utana meg egy sor." ;;
  refuse)       echo "A reply tool elutasitotta a chat_id-t, nem kuldtem semmit." ;;
  substring)    echo "Nem sikerult, ezert nem irom ki hogy \$S volna." ;;
  old_constant) echo "MORNING_SENT_OK" ;;
esac
exit $stub_rc
STUB
  chmod +x "$dir/bin/claude"
  # CLAUDE_BIN, not PATH: the script exports its own minimal PATH, so a
  # prepended stub dir is discarded and the real binary would run instead.
  HOME="$dir" CLAUDE_BIN="$dir/bin/claude" bash "$dir/scripts/morning-briefing.sh" >/dev/null 2>&1
  cat "$dir/store/.morning-last-sent" 2>/dev/null || echo "<none>"
}

echo "morning-briefing stamp gate"

assert_eq "sentinel (from the prompt, with nonce) -> stamped" \
  "$TODAY" "$(run_case success 0)"

assert_eq "refusal without sentinel -> NOT stamped (the 2026-09-13 bug)" \
  "<none>" "$(run_case refuse 0)"

assert_eq "sentinel only as part of a longer line -> NOT stamped" \
  "<none>" "$(run_case substring 0)"

assert_eq "nonzero exit with sentinel -> NOT stamped" \
  "<none>" "$(run_case success 1)"

# The nonce contract itself: the bare pre-nonce constant -- the exact string a
# run could produce by quoting its own instruction, or a replayed transcript
# from an earlier version -- must no longer satisfy the gate.
assert_eq "bare constant without the run's nonce -> NOT stamped" \
  "<none>" "$(run_case old_constant 0)"

# MORNINGPOLLER1770: delivery is the script's now -- the stamp needs the Bot API.
assert_eq "sentinel, but the Bot API answers ok:false -> NOT stamped" \
  "<none>" "$(run_case success 0 1234 0 tok-fail)"
assert_eq "sentinel present but NOT the last line -> NOT stamped" \
  "<none>" "$(run_case notlast 0)"
assert_eq "no bot token anywhere -> NOT stamped (no model call, nothing to deliver with)" \
  "<none>" "$(run_case success 0 1234 0 -)"

: > "$REQLOG"
assert_eq "long briefing -> stamped after every chunk came back ok" "$TODAY" "$(run_case long 0 1234 0 tok-long)"
CHUNKS="$(python3 -c '
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
rows=[r for r in rows if r["token"]=="tok-long" and r["method"]=="sendMessage"]
body="\n".join("sor %d: %s" % (i, "x"*30) for i in range(1,301))
joined="".join(r["text"] for r in rows)
print(len(rows), max(len(r["text"]) for r in rows) if rows else 0, "EXACT" if joined==body else "DIFF", "NOSENTINEL" if all("MORNING_SENT_OK" not in r["text"] for r in rows) else "SENTINEL-LEAKED", ",".join(sorted({r["chat_id"] for r in rows})))
' "$REQLOG")"
case "$CHUNKS" in
  "1 "*|"0 "*) fail "long briefing is split into several Bot API messages (got: $CHUNKS)" ;;
  *) pass "long briefing is split into several Bot API messages ($CHUNKS)" ;;
esac
case "$CHUNKS" in
  *" EXACT NOSENTINEL 1234") pass "chunks are byte-exact, under the limit, without the sentinel, to the owner chat" ;;
  *) fail "chunks are byte-exact, under the limit, without the sentinel, to the owner chat (got: $CHUNKS)" ;;
esac
MAXLEN="$(printf '%s' "$CHUNKS" | cut -d' ' -f2)"
if [ "${MAXLEN:-99999}" -le 4096 ]; then pass "every chunk <= 4096 chars ($MAXLEN)"; else fail "every chunk <= 4096 chars ($MAXLEN)"; fi

# CHATID0: ALLOWED_CHAT_ID=0 (the installer placeholder) with a paired
# telegram/access.json -- the run must still start, and go to the REAL
# resolved id, not the placeholder.
run_case_argv() {
  local mode="$1" stub_rc="$2" chat_id="$3" with_access="$4"
  local dir="$TMP/inst.$RANDOM"
  mkdir -p "$dir/scripts/lib" "$dir/store" "$dir/bin"
  cp "$REPO/scripts/morning-briefing.sh" "$dir/scripts/"
  cp "$REPO/scripts/lib/owner-chat.sh" "$REPO/scripts/lib/send-telegram.sh" "$dir/scripts/lib/"
  printf 'ALLOWED_CHAT_ID=%s\n' "$chat_id" > "$dir/.env"
  if [ "$with_access" = "1" ]; then
    mkdir -p "$dir/.claude/channels/telegram"
    printf 'TELEGRAM_BOT_TOKEN=x\n' > "$dir/.claude/channels/telegram/.env"
    printf '{"allowFrom":["5555"]}\n' > "$dir/.claude/channels/telegram/access.json"
  fi
  cat > "$dir/bin/claude" <<'STUB'
#!/bin/bash
printf '%s\n' "$@" > "$(dirname "$0")/../store/.claude-argv"
S="$(printf '%s\n' "$@" | grep -o 'MORNING_SENT_OK_[0-9]*_[0-9]*' | head -1)"
echo "Elkuldve."
echo "$S"
STUB
  chmod +x "$dir/bin/claude"
  HOME="$dir" CLAUDE_BIN="$dir/bin/claude" bash "$dir/scripts/morning-briefing.sh" >/dev/null 2>&1
  cat "$dir/store/.claude-argv" 2>/dev/null || echo "<no-run>"
}

# MORNINGPOLLER1770: the chat id no longer goes into the prompt (the run has no
# send tool); the SCRIPT delivers to it. The token here comes from the paired
# state dir's .env (the install .env has none), the same dir that resolved 5555.
: > "$REQLOG"
ARGV="$(run_case_argv success 0 0 1)"
DELIV="$(python3 -c '
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(" ".join(sorted({"%s@%s" % (r["chat_id"], r["token"]) for r in rows if r["method"]=="sendMessage"})))
' "$REQLOG")"
assert_eq "ALLOWED_CHAT_ID=0 + paired access.json -> delivered to the REAL resolved id with the state-dir token" "5555@x" "$DELIV"
case "$ARGV" in
  *"chat_id: 0"*) fail "the placeholder chat id never reaches the prompt (argv: $ARGV)" ;;
  *) pass "the placeholder chat id never reaches the prompt" ;;
esac

assert_eq "ALLOWED_CHAT_ID=0, no access.json -> not stamped (run does not start)" \
  "<none>" "$(run_case success 0 0 0)"

NO_ACCESS_ARGV="$(run_case_argv success 0 0 0)"
case "$NO_ACCESS_ARGV" in
  *"chat_id: 0"*) fail "ALLOWED_CHAT_ID=0, no access.json -> claude never invoked with the placeholder (argv: $NO_ACCESS_ARGV)" ;;
  "<no-run>") pass "ALLOWED_CHAT_ID=0, no access.json -> claude never invoked with the placeholder" ;;
  *) fail "ALLOWED_CHAT_ID=0, no access.json -> unexpected argv: $NO_ACCESS_ARGV" ;;
esac

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
