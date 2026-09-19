#!/bin/bash
# Contract tests for slack_progress_watchdog.py -- the wedged-turn sentry.
# Run: bash scripts/__tests__/slack-watchdog-wedged.test.sh
#
# Mirrors scripts/__tests__/telegram-watchdog-wedged.test.sh on the Slack Web
# API (chat.postMessage / chat.delete / chat.update). Locks:
#   - a WEDGED turn (agent up, reply MCP call hung) is handled well before the
#     15-min backstop and gets the agent's REAL answer, in-thread;
#   - a legitimately long task (no hung reply) is left alone before the backstop;
#   - TGORPHAN908 guards: stale upper bound, round-scoped answer attribution,
#     no resend when the round's reply already reached the channel;
#   - delivery failures are never success: Slack's HTTP-200 {"ok":false},
#     HTTP 429/5xx and an unreachable API are all observable through the stub
#     (stub_mode); a RETRYABLE failure keeps the marker with its mtime intact
#     and the next tick delivers, a TERMINAL rejection falls through to the
#     generic-error rewrite, a partial failure keeps only the failed entry.
#
# Fully hermetic: HOME and MARVEEN_ROOT are pinned to a temp tree so the
# watchdog only ever scans test dirs (never the real ~/.claude), and all Web
# API traffic is routed to a local stub via SLACK_API_BASE.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WATCHDOG="$INSTALL_DIR/scripts/hooks/slack_progress_watchdog.py"

TMP="$(mktemp -d)"
trap 'kill "$STUB_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

# --- Local Web API stub (logs "<method> <body>" per request) -----------------
# Failure injection: MODEFILE holds lines "<method|*> <mode> [count]" with
# mode = ok | ok_false:<error> | http:<status>. The first matching line answers
# a request; a line with a count is consumed by that many requests and then
# skipped. No file / no match = {"ok": true}. Slack reports application errors
# as HTTP 200 + {"ok": false, "error": ...}, so a stub that can only say ok:true
# leaves the suite blind to every real failure shape (review task #3).
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
        status, out = 200, {"ok": True, "ts": "1700000000.900100"}
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

CHAT="C0BJTESTCHAN"
PH_TS="1700000000.000100"
THREAD_TS="1699999999.000001"
ANSWER="EZ_A_VALODI_VALASZ amit a usernek latnia kell"

# Build a per-case agent state dir + transcript, then return the progress dir.
# kind = hung  -> last tool_use is a Slack reply with NO result (round hung)
# kind = work  -> last tool_use is a Bash WITH a result (legit long task)
# kind = noans -> hung reply but NO assistant text (nothing to deliver)
make_case() { # name kind age_seconds
    local name="$1" kind="$2" age="$3"
    local pdir="$TMP/root/agents/$name/.claude/channels/slack/progress"
    local sdir="$TMP/root/agents/$name/.claude/channels/slack"
    mkdir -p "$pdir"
    printf 'SLACK_BOT_TOKEN=xoxb-TESTTOKEN\n' > "$sdir/.env"
    local tr="$sdir/transcript.jsonl"
    case "$kind" in
      hung)
        { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"}]}}';
          printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tuReply1","name":"mcp__plugin_slack-channel_slack__reply"}]}}'; } > "$tr" ;;
      noans)
        printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tuReply1","name":"mcp__plugin_slack-channel_slack__reply"}]}}' > "$tr" ;;
      work)
        { printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"},{"type":"tool_use","id":"tuBash1","name":"Bash"}]}}';
          printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tuBash1"}]}}'; } > "$tr" ;;
    esac
    printf '[{"chat_id":"%s","ts":"%s","thread_ts":"%s","transcript_path":"%s"}]\n' \
        "$CHAT" "$PH_TS" "$THREAD_TS" "$tr" > "$pdir/SID.json"
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
    HOME="$TMP" MARVEEN_ROOT="$TMP/root" SLACK_API_BASE="$API_BASE" \
      SLACK_WATCHDOG_FORCE_AGENT_UP="$1" SLACK_WATCHDOG_WEDGED_UP_SEC="$2" \
      python3 "$WATCHDOG"
}
# Failure injection for the stub: each argument is one "<method|*> <mode>
# [count]" line (see the stub header); no arguments = everything answers ok.
stub_mode() { : > "$MODEFILE"; local l; for l in "$@"; do printf '%s\n' "$l" >> "$MODEFILE"; done; }
mtime_of() { python3 -c 'import os,sys; print(int(os.path.getmtime(sys.argv[1])))' "$1"; }
log_has() { grep -q "$2" "$1/debug.log" 2>/dev/null && echo yes || echo no; }
pend_count() { python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$1/SID.json" 2>/dev/null || echo 0; }

echo "slack-watchdog-wedged tests"
echo "==========================="

# ---------------------------------------------------------------------------
# (a) Agent UP + hung reply + past the fast threshold -> deliver REAL answer
# ---------------------------------------------------------------------------
echo ""
echo "(a) Wedged (hung reply): fast, real answer, in-thread"
PA="$(make_case wa hung 100)"
run_wd 1 1
assert_eq "fires fast: one real-answer chat.postMessage" "1" "$(count chat.postMessage)"
assert_eq "delivers the REAL answer text (not a generic error)" "yes" "$(body_has "EZ_A_VALODI_VALASZ")"
assert_eq "answer goes into the placeholder's thread" "yes" "$(body_has "\"thread_ts\": \"$THREAD_TS\"")"
assert_eq "clears the placeholder (chat.delete)" "1" "$(count chat.delete)"
assert_eq "placeholder deleted by its own ts" "yes" "$(body_has "\"ts\": \"$PH_TS\"")"
assert_eq "no generic-error edit" "0" "$(count chat.update)"
assert_eq "state file removed after handling" "no" "$(pend_exists "$PA")"

# ---------------------------------------------------------------------------
# (b) Agent UP + NO hung reply, before the backstop -> DO NOT touch it
# ---------------------------------------------------------------------------
echo ""
echo "(b) Legit long task (no hung reply): untouched before backstop"
PB="$(make_case wb work 100)"
run_wd 1 1
assert_eq "no delivery for a legitimately working task" "0" "$(count chat.postMessage)"
assert_eq "no error edit for a working task" "0" "$(count chat.update)"
assert_eq "placeholder preserved (task still running)" "yes" "$(pend_exists "$PB")"

# ---------------------------------------------------------------------------
# (c) Agent UP + no hung reply but past the 15-min backstop -> fire
# ---------------------------------------------------------------------------
echo ""
echo "(c) Backstop: no hung reply but very old -> fire with real answer"
PC="$(make_case wc work 1000)"   # 1000s > WEDGED_SEC (900)
run_wd 1 1
assert_eq "backstop fires: one delivery" "1" "$(count chat.postMessage)"
assert_eq "state file removed" "no" "$(pend_exists "$PC")"

# ---------------------------------------------------------------------------
# (d) Agent DOWN + past the down grace -> fire with real answer
# ---------------------------------------------------------------------------
echo ""
echo "(d) Agent down: fire with real answer"
PD="$(make_case wd hung 200)"    # 200s > DOWN_GRACE_SEC (120)
run_wd 0 1
assert_eq "down path fires: one delivery" "1" "$(count chat.postMessage)"
assert_eq "delivers the real answer" "yes" "$(body_has "EZ_A_VALODI_VALASZ")"

# ---------------------------------------------------------------------------
# (e) Hung reply but NO recoverable answer -> generic error, keep placeholder
# ---------------------------------------------------------------------------
echo ""
echo "(e) Nothing to deliver: falls back to generic error edit"
PE="$(make_case we noans 100)"
run_wd 1 1
assert_eq "no real-answer send (nothing to deliver)" "0" "$(count chat.postMessage)"
assert_eq "rewrites placeholder into a generic error (chat.update)" "1" "$(count chat.update)"
assert_eq "error text used" "yes" "$(body_has "Valami elakadt")"
assert_eq "placeholder kept (edited, not deleted)" "0" "$(count chat.delete)"

# ---------------------------------------------------------------------------
# TGORPHAN908 cases: stale upper bound + round-scoped answer attribution.
# ---------------------------------------------------------------------------

# Build a case whose transcript carries TIMESTAMPED user prompts (real format).
# layout = delivered | undelivered | foreign
#   delivered:   round-1 prompt @ marker time, answer text + reply call WITH
#                result; then a later internal round with monologue text.
#   undelivered: round-1 prompt @ marker time, answer text, NO reply call;
#                then a later internal round with monologue text.
#   foreign:     only a later round's prompt (nothing at/before marker time).
make_ts_case() { # name layout age_seconds
    local name="$1" layout="$2" age="$3"
    local pdir="$TMP/root/agents/$name/.claude/channels/slack/progress"
    local sdir="$TMP/root/agents/$name/.claude/channels/slack"
    mkdir -p "$pdir"
    printf 'SLACK_BOT_TOKEN=xoxb-TESTTOKEN\n' > "$sdir/.env"
    local tr="$sdir/transcript.jsonl"
    python3 - "$tr" "$layout" "$age" <<'PY'
import datetime, json, sys, time
tr, layout, age = sys.argv[1], sys.argv[2], int(sys.argv[3])
now = time.time()
def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
t1, t2 = now - age, now - age / 2
ev = []
if layout in ("delivered", "undelivered"):
    ev.append({"type": "user", "timestamp": iso(t1),
               "message": {"role": "user", "content": "csatorna-kerdes"}})
    blocks = [{"type": "text", "text": "VALODI_T1_VALASZ a csatornanak"}]
    if layout == "delivered":
        blocks.append({"type": "tool_use", "id": "tuR1",
                       "name": "mcp__plugin_slack-channel_slack__reply"})
    ev.append({"type": "assistant", "message": {"role": "assistant", "content": blocks}})
    if layout == "delivered":
        ev.append({"type": "user", "message": {"role": "user",
                   "content": [{"type": "tool_result", "tool_use_id": "tuR1"}]}})
ev.append({"type": "user", "timestamp": iso(t2),
           "message": {"role": "user", "content": "belso scheduled kor"}})
ev.append({"type": "assistant", "message": {"role": "assistant",
           "content": [{"type": "text", "text": "BELSO_NAPLO Szabinak nem kuldtem semmit"}]}})
with open(tr, "w") as f:
    for e in ev:
        f.write(json.dumps(e) + "\n")
PY
    printf '[{"chat_id":"%s","ts":"%s","transcript_path":"%s"}]\n' "$CHAT" "$PH_TS" "$tr" \
        > "$pdir/SID.json"
    python3 - "$pdir/SID.json" "$age" <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
    echo "$pdir"
}

echo ""
echo "(f) Stale (28 days): dropped, placeholder deleted, nothing delivered"
PF="$(make_case wf hung $((28 * 86400)))"
run_wd 1 1
assert_eq "no real-answer send for a dead round" "0" "$(count chat.postMessage)"
assert_eq "no error edit for a dead round" "0" "$(count chat.update)"
assert_eq "placeholder deleted (Slack has no delete window)" "1" "$(count chat.delete)"
assert_eq "state file removed (cleanup, not collection)" "no" "$(pend_exists "$PF")"

echo ""
echo "(g) Stale bound is env-tunable (SLACK_WATCHDOG_STALE_SEC)"
PG="$(make_case wg hung 1000)"   # > WEDGED_SEC, but also > the 500s stale bound below
: > "$REQLOG"
HOME="$TMP" MARVEEN_ROOT="$TMP/root" SLACK_API_BASE="$API_BASE" \
  SLACK_WATCHDOG_FORCE_AGENT_UP=1 SLACK_WATCHDOG_STALE_SEC=500 python3 "$WATCHDOG"
assert_eq "tuned stale bound: no delivery" "0" "$(count chat.postMessage)"
assert_eq "tuned stale bound: placeholder deleted" "1" "$(count chat.delete)"
assert_eq "tuned stale bound: state file removed" "no" "$(pend_exists "$PG")"

echo ""
echo "(h) Round's reply already delivered: silent clear, NO resend of anything"
PH="$(make_ts_case wh delivered 1000)"
run_wd 1 1
assert_eq "no resend (answer already reached the channel)" "0" "$(count chat.postMessage)"
assert_eq "no error edit" "0" "$(count chat.update)"
assert_eq "internal monologue never sent" "no" "$(body_has "BELSO_NAPLO")"
assert_eq "placeholder cleaned up" "1" "$(count chat.delete)"
assert_eq "state file removed" "no" "$(pend_exists "$PH")"

echo ""
echo "(i) Answer scoped to the marker's round, not the transcript's last text"
PI="$(make_ts_case wi undelivered 1000)"
run_wd 1 1
assert_eq "backstop fires: one delivery" "1" "$(count chat.postMessage)"
assert_eq "delivers the marker round's own text" "yes" "$(body_has "VALODI_T1_VALASZ")"
assert_eq "later internal turn's text NOT sent" "no" "$(body_has "BELSO_NAPLO")"
assert_eq "state file removed" "no" "$(pend_exists "$PI")"

echo ""
echo "(j) Timestamped transcript with no prompt at the marker: unattributable"
PJ="$(make_ts_case wj foreign 1000)"
run_wd 1 1
assert_eq "no text delivery (nothing attributable)" "0" "$(count chat.postMessage)"
assert_eq "internal text NOT leaked" "no" "$(body_has "BELSO_NAPLO")"
assert_eq "falls back to generic error" "1" "$(count chat.update)"
assert_eq "state file removed" "no" "$(pend_exists "$PJ")"

# ---------------------------------------------------------------------------
# (k) #915: the install-scoped main-agent state dir is scanned too
# ---------------------------------------------------------------------------
echo ""
echo "(k) Install-scoped state dir (<root>/.claude/channels/slack) is scanned"
PK_S="$TMP/root/.claude/channels/slack"; PK="$PK_S/progress"
mkdir -p "$PK"
printf 'SLACK_BOT_TOKEN=xoxb-TESTTOKEN\n' > "$PK_S/.env"
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"'"$ANSWER"'"}]}}' > "$PK_S/transcript.jsonl"
printf '[{"chat_id":"%s","ts":"%s","transcript_path":"%s"}]\n' "$CHAT" "$PH_TS" "$PK_S/transcript.jsonl" > "$PK/SID.json"
python3 - "$PK/SID.json" 1000 <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
run_wd 1 1
assert_eq "install-scoped dir: backstop delivery" "1" "$(count chat.postMessage)"
assert_eq "install-scoped dir: state file removed" "no" "$(pend_exists "$PK")"

# ---------------------------------------------------------------------------
# (l) Install language: the error rewrite follows <root>/.lang, MARVEEN_LANG wins
# ---------------------------------------------------------------------------
echo ""
echo "(l) Language: .lang=en -> English error text; MARVEEN_LANG overrides"
printf 'en\n' > "$TMP/root/.lang"
PL="$(make_case wl noans 100)"
run_wd 1 1
assert_eq "lang=en: one error edit" "1" "$(count chat.update)"
assert_eq "lang=en: English error text" "yes" "$(body_has "Something got stuck")"
assert_eq "lang=en: no Hungarian text" "no" "$(body_has "Valami elakadt")"
PL2="$(make_case wl2 noans 100)"
: > "$REQLOG"
HOME="$TMP" MARVEEN_ROOT="$TMP/root" SLACK_API_BASE="$API_BASE" MARVEEN_LANG=hu \
  SLACK_WATCHDOG_FORCE_AGENT_UP=1 SLACK_WATCHDOG_WEDGED_UP_SEC=1 python3 "$WATCHDOG"
assert_eq "MARVEEN_LANG=hu overrides .lang: Hungarian text" "yes" "$(body_has "Valami elakadt")"
rm -f "$TMP/root/.lang"

# ---------------------------------------------------------------------------
# (m) Submit hook: the placeholder text follows the same language resolution
# ---------------------------------------------------------------------------
echo ""
echo "(m) Submit hook placeholder: hu default, en via .lang"
SUBMIT="$INSTALL_DIR/scripts/hooks/slack_progress.py"
SM="$TMP/root/agents/wm/.claude/channels/slack"; mkdir -p "$SM"
printf 'SLACK_BOT_TOKEN=xoxb-TESTTOKEN\n' > "$SM/.env"
PROMPT='<channel source="plugin:slack-channel:slack" chat_id="C0BJTESTCHAN" ts="1700000000.000200">hello</channel>'
: > "$REQLOG"
OUT_M="$(printf '{"session_id":"sm1","prompt":"%s"}' "$(printf '%s' "$PROMPT" | sed 's/"/\\"/g')" \
  | SLACK_STATE_DIR="$SM" SLACK_API_BASE="$API_BASE" python3 "$SUBMIT")"
assert_eq "submit: one placeholder posted" "1" "$(count chat.postMessage)"
assert_eq "submit: Hungarian placeholder by default" "yes" "$(body_has "Dolgozom rajta")"
# UserPromptSubmit stdout is injected into the model prompt: it must be empty.
assert_eq "submit: silent stdout" "" "$OUT_M"
assert_eq "submit: state entry stored with the placeholder ts" "yes" \
  "$(grep -q '"ts": "1700000000.900100"' "$SM/progress/sm1.json" && echo yes || echo no)"
printf 'en\n' > "$TMP/root/.lang"
: > "$REQLOG"
printf '{"session_id":"sm2","prompt":"%s"}' "$(printf '%s' "$PROMPT" | sed 's/"/\\"/g')" \
  | SLACK_STATE_DIR="$SM" SLACK_API_BASE="$API_BASE" python3 "$SUBMIT"
assert_eq "submit: English placeholder with .lang=en" "yes" "$(body_has "Working on it")"
rm -f "$TMP/root/.lang"

echo ""
echo "(m2) Submit hook: a rejected placeholder (ok:false) stores no state"
stub_mode "chat.postMessage ok_false:not_in_channel"
: > "$REQLOG"
OUT_M3="$(printf '{"session_id":"sm3","prompt":"%s"}' "$(printf '%s' "$PROMPT" | sed 's/"/\\"/g')" \
  | SLACK_STATE_DIR="$SM" SLACK_API_BASE="$API_BASE" python3 "$SUBMIT")"
assert_eq "submit ok:false: one attempt" "1" "$(count chat.postMessage)"
assert_eq "submit ok:false: no state file (nothing to clear later)" "no" \
  "$([ -f "$SM/progress/sm3.json" ] && echo yes || echo no)"
assert_eq "submit ok:false: silent stdout" "" "$OUT_M3"
stub_mode

# ---------------------------------------------------------------------------
# Delivery failures (review task #3). Slack answers application errors with
# HTTP 200 + {"ok": false, "error": ...}; the Telegram Bot API uses HTTP 4xx,
# so the ported watchdog silently treated a rejected post as delivered:
# "real-answer" in the log, placeholder deleted, marker dropped, user got
# nothing. The stub can now say ok:false / 429 / 5xx, and the watchdog must
# neither claim success nor lose the orphan.
# ---------------------------------------------------------------------------
echo ""
echo "(n) postMessage ok:false TERMINAL (channel_not_found): generic error instead, marker dropped"
PN="$(make_case wn hung 100)"
stub_mode "chat.postMessage ok_false:channel_not_found"
run_wd 1 1
assert_eq "terminal: one postMessage attempt" "1" "$(count chat.postMessage)"
assert_eq "terminal: placeholder NOT deleted (nothing was delivered)" "0" "$(count chat.delete)"
assert_eq "terminal: placeholder rewritten into the generic error" "1" "$(count chat.update)"
assert_eq "terminal: error text used" "yes" "$(body_has "Valami elakadt")"
assert_eq "terminal: marker dropped (retrying cannot help)" "no" "$(pend_exists "$PN")"
assert_eq "terminal: the Slack error is in the log" "yes" "$(log_has "$PN" "channel_not_found")"
assert_eq "terminal: log says rejected, no retry" "yes" "$(log_has "$PN" "rejected, no retry")"
assert_eq "terminal: log never claims real-answer" "no" "$(log_has "$PN" "delivered=real-answer")"
stub_mode

echo ""
echo "(o) postMessage HTTP 429 (RETRYABLE): nothing touched, marker kept with its mtime; next tick delivers"
PO="$(make_case wo hung 100)"
MT_BEFORE="$(mtime_of "$PO/SID.json")"
stub_mode "chat.postMessage http:429"
run_wd 1 1
assert_eq "429: one postMessage attempt" "1" "$(count chat.postMessage)"
assert_eq "429: placeholder NOT deleted" "0" "$(count chat.delete)"
assert_eq "429: no error edit either (a retry may still deliver the answer)" "0" "$(count chat.update)"
assert_eq "429: marker KEPT for the next tick" "yes" "$(pend_exists "$PO")"
assert_eq "429: marker mtime preserved (age + round anchor stand)" "$MT_BEFORE" "$(mtime_of "$PO/SID.json")"
assert_eq "429: log says will retry" "yes" "$(log_has "$PO" "will retry")"
stub_mode
run_wd 1 1
assert_eq "429 then ok: the retry delivers the real answer" "1" "$(count chat.postMessage)"
assert_eq "429 then ok: real answer text" "yes" "$(body_has "EZ_A_VALODI_VALASZ")"
assert_eq "429 then ok: placeholder deleted" "1" "$(count chat.delete)"
assert_eq "429 then ok: marker removed" "no" "$(pend_exists "$PO")"

echo ""
echo "(p) postMessage ok:false ratelimited / HTTP 503: retryable too"
PP="$(make_case wp hung 100)"
stub_mode "chat.postMessage ok_false:ratelimited"
run_wd 1 1
assert_eq "ratelimited: marker kept" "yes" "$(pend_exists "$PP")"
assert_eq "ratelimited: placeholder untouched" "0" "$(count chat.delete)"
rm -f "$PP/SID.json"
PP2="$(make_case wp2 hung 100)"
stub_mode "chat.postMessage http:503"
run_wd 1 1
assert_eq "503: marker kept" "yes" "$(pend_exists "$PP2")"
assert_eq "503: placeholder untouched" "0" "$(count chat.delete)"
rm -f "$PP2/SID.json"
stub_mode

echo ""
echo "(q) Generic-error path: chat.update terminal -> logged, marker dropped; chat.update 5xx -> marker kept"
PQ="$(make_case wq noans 100)"
stub_mode "chat.update ok_false:message_not_found"
run_wd 1 1
assert_eq "update terminal: one edit attempt" "1" "$(count chat.update)"
assert_eq "update terminal: marker dropped (nothing more to do)" "no" "$(pend_exists "$PQ")"
assert_eq "update terminal: logged with the Slack error" "yes" "$(log_has "$PQ" "message_not_found")"
PQ2="$(make_case wq2 noans 100)"
stub_mode "chat.update http:502"
run_wd 1 1
assert_eq "update 502: marker kept for a retry" "yes" "$(pend_exists "$PQ2")"
assert_eq "update 502: log says will retry" "yes" "$(log_has "$PQ2" "error edit failed, will retry")"
rm -f "$PQ2/SID.json"
stub_mode

echo ""
echo "(r) API unreachable (connection refused): retryable, marker kept, nothing claimed"
PR="$(make_case wr hung 100)"
DEAD_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
: > "$REQLOG"
HOME="$TMP" MARVEEN_ROOT="$TMP/root" SLACK_API_BASE="http://127.0.0.1:$DEAD_PORT" \
  SLACK_WATCHDOG_FORCE_AGENT_UP=1 SLACK_WATCHDOG_WEDGED_UP_SEC=1 python3 "$WATCHDOG"
assert_eq "dead API: marker kept" "yes" "$(pend_exists "$PR")"
assert_eq "dead API: log says will retry" "yes" "$(log_has "$PR" "will retry")"
assert_eq "dead API: no success claimed" "no" "$(log_has "$PR" "delivered=real-answer")"
rm -f "$PR/SID.json"

echo ""
echo "(s) Two pending entries, first send fails retryable: only the failed one stays, mtime preserved"
PS_="$(make_case ws hung 100)"
TR_S="$TMP/root/agents/ws/.claude/channels/slack/transcript.jsonl"
printf '[{"chat_id":"%s","ts":"%s","transcript_path":"%s"},{"chat_id":"C0BJSECOND","ts":"1700000000.000300","transcript_path":"%s"}]\n' \
    "$CHAT" "$PH_TS" "$TR_S" "$TR_S" > "$PS_/SID.json"
python3 - "$PS_/SID.json" 100 <<'PY'
import os, sys, time
os.utime(sys.argv[1], (time.time()-int(sys.argv[2]),)*2)
PY
MT_BEFORE="$(mtime_of "$PS_/SID.json")"
stub_mode "chat.postMessage http:429 1"
run_wd 1 1
assert_eq "partial: two postMessage attempts" "2" "$(count chat.postMessage)"
assert_eq "partial: the delivered entry's placeholder deleted" "1" "$(count chat.delete)"
assert_eq "partial: second chat's answer delivered" "yes" "$(body_has "\"channel\": \"C0BJSECOND\"")"
assert_eq "partial: marker kept" "yes" "$(pend_exists "$PS_")"
assert_eq "partial: only the failed entry remains" "1" "$(pend_count "$PS_")"
assert_eq "partial: the remaining entry is the failed one" "yes" \
  "$(grep -q "\"$PH_TS\"" "$PS_/SID.json" && echo yes || echo no)"
assert_eq "partial: mtime preserved after the rewrite" "$MT_BEFORE" "$(mtime_of "$PS_/SID.json")"
stub_mode
run_wd 1 1
assert_eq "partial then ok: exactly one more postMessage (no duplicate for the delivered chat)" "1" "$(count chat.postMessage)"
assert_eq "partial then ok: it goes to the failed chat" "yes" "$(body_has "\"channel\": \"$CHAT\"")"
assert_eq "partial then ok: marker removed" "no" "$(pend_exists "$PS_")"

# ---------------------------------------------------------------------------
echo ""
echo "==========================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
