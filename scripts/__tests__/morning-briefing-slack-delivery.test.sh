#!/bin/bash
# MBSLACKFALLBACK1007 (SLACKATALLAS1006): the morning briefing delivers by the
# notify.sh channel rule -- Slack first when NOTIFY_SLACK_TARGET is set, Telegram
# too unless Slack delivered and NOTIFY_TELEGRAM=0 -- and stamps the day when at
# least one channel delivered the whole text. A Slack-only install (no Telegram
# token, no owner chat) used to skip silently ("kihagyva"): nothing reached
# anyone.
#
# Hermetic: a stub `claude`, the REAL scripts/slack-notify.mjs over stub dist/
# modules (settings from a per-case JSON file, sendSlackNotification records to
# a file), and a local Bot API stub. Run: bash scripts/__tests__/morning-briefing-slack-delivery.test.sh

set -u
unset TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR
# The test-run marker and tmux sender attribution would change the text; this
# test sends to stubs only.
unset VITEST NODE_ENV TMUX

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
TODAY="$(date +%F)"

REQLOG="$TMP/tg-requests.log"; PORTFILE="$TMP/port"
cat > "$TMP/stub.py" <<'PYEOF'
import json, sys
from urllib.parse import parse_qs
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8") if n else ""
        _, tok, method = self.path.split("/", 2)
        tok = tok[3:]
        q = {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}
        with open(sys.argv[1], "a", encoding="utf-8") as f:
            f.write(json.dumps({"token": tok, "method": method, "chat_id": q.get("chat_id"), "text": q.get("text")}, ensure_ascii=False) + "\n")
        out = {"ok": False, "description": "stub: forced failure"} if "fail" in tok else {"ok": True, "result": {"message_id": 1}}
        payload = json.dumps(out, separators=(",", ":")).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
srv = HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[2], "w").write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF
python3 "$TMP/stub.py" "$REQLOG" "$PORTFILE" &
STUB_PID=$!
disown "$STUB_PID" 2>/dev/null
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do [ -s "$PORTFILE" ] && break; sleep 0.1; done
[ -s "$PORTFILE" ] || { echo "FATAL: Bot API stub did not start"; exit 1; }
export TELEGRAM_API_BASE="http://127.0.0.1:$(cat "$PORTFILE")"

BODY_TEXT="Reggeli napindito: 3 level & 2 esemeny <ma>."

# run_case NAME TG_TOKEN(-=none) CHAT_ID(-=none) SLACK_TARGET(-=none) NOTIFY_TELEGRAM SLACK_MODE(ok|fail)
# -> sets DIR; prints nothing. Inspect: $DIR/store/.morning-last-sent, $DIR/slack.log, $REQLOG.
run_case() {
  local name="$1" tok="$2" chat="$3" target="$4" ntg="$5" smode="$6"
  DIR="$TMP/$name"
  mkdir -p "$DIR/scripts/lib" "$DIR/store" "$DIR/bin" "$DIR/dist"
  cp "$REPO/scripts/morning-briefing.sh" "$REPO/scripts/slack-notify.mjs" "$DIR/scripts/"
  cp "$REPO/scripts/lib/owner-chat.sh" "$REPO/scripts/lib/send-telegram.sh" "$DIR/scripts/lib/"
  : > "$DIR/.env"
  [ "$chat" = "-" ] || printf 'ALLOWED_CHAT_ID=%s\n' "$chat" >> "$DIR/.env"
  [ "$tok" = "-" ] || printf 'TELEGRAM_BOT_TOKEN=%s\n' "$tok" >> "$DIR/.env"
  printf '{"type":"module"}\n' > "$DIR/dist/package.json"
  python3 -c 'import json,sys; t,n=sys.argv[1],sys.argv[2]; d={}; 
if t!="-": d["NOTIFY_SLACK_TARGET"]=t
if n!="-": d["NOTIFY_TELEGRAM"]=n
d["SLACK_OWNER_USER_ID"]="U0"; json.dump(d,open(sys.argv[3],"w"))' "$target" "$ntg" "$DIR/dist/settings.json"
  cat > "$DIR/dist/settings-store.js" <<'JS'
import { readFileSync } from 'node:fs'
const s = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf-8'))
export function getEffectiveSettingValue(k) { return s[k] ?? '' }
JS
  cat > "$DIR/dist/slack-notify.js" <<JS
import { appendFileSync } from 'node:fs'
export async function sendSlackNotification(to, text, opts) {
  appendFileSync('$DIR/slack.log', JSON.stringify({ to, text, sender: opts && opts.sender || null }) + '\n')
  return '$smode' === 'ok' ? { ok: true } : { ok: false, error: 'stub: forced failure' }
}
JS
  printf 'export const markIfTestRun = (t) => t\n' > "$DIR/dist/test-run-marker.js"
  cat > "$DIR/bin/claude" <<STUB
#!/bin/bash
printf '%s\n' "\$@" > "$DIR/store/argv"
S="\$(printf '%s\n' "\$@" | grep -o 'MORNING_SENT_OK_[0-9]*_[0-9]*' | head -1)"
echo "$BODY_TEXT"; echo "\$S"
STUB
  chmod +x "$DIR/bin/claude"
  : > "$REQLOG"
  HOME="$DIR" CLAUDE_BIN="$DIR/bin/claude" bash "$DIR/scripts/morning-briefing.sh" >/dev/null 2>&1
}
stamp() { cat "$DIR/store/.morning-last-sent" 2>/dev/null || echo "<none>"; }
slack_texts() { python3 -c 'import json,sys; print("|".join(json.loads(l)["to"]+"="+json.loads(l)["text"] for l in open(sys.argv[1]) if l.strip()))' "$DIR/slack.log" 2>/dev/null; }
tg_sends() { python3 -c 'import json,sys; r=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; print("|".join(x["chat_id"]+"="+x["text"] for x in r if x["method"]=="sendMessage"))' "$REQLOG"; }

echo "morning-briefing: Slack and Telegram delivery (MBSLACKFALLBACK1007)"

run_case slack-only - - dm - ok
assert_eq "Slack-only install -> the model runs (no early skip)" "yes" "$([ -f "$DIR/store/argv" ] && echo yes || echo no)"
assert_eq "Slack-only -> the whole text to the Slack owner target, byte-exact" "dm=$BODY_TEXT" "$(slack_texts)"
assert_eq "Slack-only -> no Telegram send" "" "$(tg_sends)"
assert_eq "Slack-only, Slack delivered -> stamped" "$TODAY" "$(stamp)"
if grep -qx -- '--channels' "$DIR/store/argv"; then fail "Slack-only: still no --channels on the model call"; else pass "Slack-only: still no --channels on the model call"; fi

run_case slack-only-fail - - dm - fail
assert_eq "Slack-only, Slack failed -> NOT stamped" "<none>" "$(stamp)"

run_case tg-only tok-ok 1234 - - ok
assert_eq "Telegram-only -> no Slack call" "" "$(slack_texts)"
assert_eq "Telegram-only -> Telegram to the owner chat, byte-exact" "1234=$BODY_TEXT" "$(tg_sends)"
assert_eq "Telegram-only -> stamped" "$TODAY" "$(stamp)"

run_case both tok-ok 1234 dm - ok
assert_eq "both, NOTIFY_TELEGRAM unset -> Slack gets it" "dm=$BODY_TEXT" "$(slack_texts)"
assert_eq "both, NOTIFY_TELEGRAM unset -> Telegram gets it too" "1234=$BODY_TEXT" "$(tg_sends)"
assert_eq "both -> stamped" "$TODAY" "$(stamp)"

run_case both-tg-off tok-ok 1234 dm 0 ok
assert_eq "both, NOTIFY_TELEGRAM=0, Slack ok -> Slack only" "dm=$BODY_TEXT" "$(slack_texts)"
assert_eq "both, NOTIFY_TELEGRAM=0, Slack ok -> no Telegram send" "" "$(tg_sends)"
assert_eq "both, NOTIFY_TELEGRAM=0 -> stamped" "$TODAY" "$(stamp)"

run_case both-tg-off-slackfail tok-ok 1234 dm 0 fail
assert_eq "NOTIFY_TELEGRAM=0 but Slack failed -> Telegram still goes out" "1234=$BODY_TEXT" "$(tg_sends)"
assert_eq "NOTIFY_TELEGRAM=0, Slack failed, Telegram ok -> stamped" "$TODAY" "$(stamp)"

run_case both-tgfail tok-fail 1234 dm - ok
assert_eq "Slack ok, Telegram refused -> stamped (the owner got it on Slack)" "$TODAY" "$(stamp)"

run_case both-allfail tok-fail 1234 dm - fail
assert_eq "Slack failed AND Telegram refused -> NOT stamped" "<none>" "$(stamp)"

run_case neither - - - - ok
assert_eq "neither channel -> the model is not called" "no" "$([ -f "$DIR/store/argv" ] && echo yes || echo no)"
assert_eq "neither channel -> NOT stamped" "<none>" "$(stamp)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
