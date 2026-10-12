#!/bin/bash
# Contract tests for scripts/stuck-modal-guard.sh.
# Run: bash scripts/__tests__/stuck-modal-guard.test.sh
#
# Pins the pure pane classifier (idle / busy / stuck / empty) against captured
# pane fixtures and the confirm-window decision, so the false-positive guarantee
# ("a legitimately working session is NEVER touched") is locked by a test.

set -u

# Hermetic (#1555 review round 1): inside an agent session the inherited
# channel state dir points at a live access.json / bot token.
unset TELEGRAM_STATE_DIR SLACK_STATE_DIR DISCORD_STATE_DIR GOOGLECHAT_STATE_DIR TEAMS_STATE_DIR

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GUARD="$INSTALL_DIR/scripts/stuck-modal-guard.sh"

classify() { printf '%s' "$1" | bash "$GUARD" classify; }
decide()   { bash "$GUARD" decide "$1" "$2" "$3"; }

echo "stuck-modal-guard tests"
echo "======================="

# ---------------------------------------------------------------------------
# (a) Classifier: healthy panes -> idle / busy (NEVER stuck)
# ---------------------------------------------------------------------------
echo ""
echo "(a) Healthy panes are never 'stuck'"

IDLE_BYPASS='Some reply text from the agent.
                                                      ⏵⏵ bypass permissions on (shift+tab to cycle)'
assert_eq "idle: bypass-permissions footer" "idle" "$(classify "$IDLE_BYPASS")"

IDLE_SHORTCUTS='╭─────────────╮
│ ❯           │
╰─────────────╯
  ? for shortcuts'
assert_eq "idle: '? for shortcuts' footer" "idle" "$(classify "$IDLE_SHORTCUTS")"

BUSY_INTERRUPT='✻ Combobulating… (8s · ↓ 1.2k tokens · esc to interrupt)
⏵⏵ bypass permissions on (shift+tab to cycle)'
assert_eq "busy: 'esc to interrupt' (working footer) -> busy NOT stuck" "busy" "$(classify "$BUSY_INTERRUPT")"

BUSY_TOKENS='✻ Thinking… (52s · ↓ 2.6k tokens)'
assert_eq "busy: token counter '(Ns · ↓' -> busy" "busy" "$(classify "$BUSY_TOKENS")"

# W2 regression: the counter separator may render as an ASCII period (locale /
# terminal dependent) instead of the Unicode middle-dot. A working pane MUST
# still classify as busy, never stuck (else it gets respawned mid-turn).
BUSY_TOKENS_ASCII='✻ Thinking… (52s . ↓ 2.6k tokens)'
assert_eq "busy: token counter '(Ns . ↓' ASCII-dot -> busy" "busy" "$(classify "$BUSY_TOKENS_ASCII")"

# ---------------------------------------------------------------------------
# (b) Classifier: a wedged /mcp modal -> stuck
# ---------------------------------------------------------------------------
echo ""
echo "(b) Wedged /mcp modal is 'stuck'"

MCP_MODAL='Manage MCP servers

  ❯ 1. telegram   ✗ failed
       Reconnect
       View tools

  Esc to go back'
assert_eq "stuck: /mcp modal (no idle/busy markers)" "stuck" "$(classify "$MCP_MODAL")"

TRUST_DIALOG='Do you trust the files in this folder?
  1. Yes
  2. No'
assert_eq "stuck: an unexpected blocking dialog with no footer" "stuck" "$(classify "$TRUST_DIALOG")"

# ---------------------------------------------------------------------------
# (c) Classifier: empty capture -> empty (inconclusive)
# ---------------------------------------------------------------------------
echo ""
echo "(c) Empty capture"
assert_eq "empty: whitespace-only pane" "empty" "$(classify '
   ')"

# ---------------------------------------------------------------------------
# (d) Decision: confirm-window persistence (anti-flap) + healthy-clears
# ---------------------------------------------------------------------------
echo ""
echo "(d) Confirm-window decision (STUCK_SECONDS=120)"
assert_eq "decide: first stuck sighting -> start-confirm" "start-confirm" "$(decide stuck 0 1000)"
assert_eq "decide: stuck 30s (< 120) -> wait-confirm"     "wait-confirm"  "$(decide stuck 970 1000)"
assert_eq "decide: stuck 200s (>= 120) -> act"            "act"           "$(decide stuck 800 1000)"
assert_eq "decide: idle -> clear confirm window"          "clear"         "$(decide idle 800 1000)"
assert_eq "decide: busy -> clear confirm window"          "clear"         "$(decide busy 800 1000)"
assert_eq "decide: empty capture -> hold (preserve window)" "hold"        "$(decide empty 800 1000)"

# Custom STUCK_SECONDS is honoured (env override)
assert_eq "decide: honours STUCK_MODAL_SECONDS override" "act" \
  "$(STUCK_MODAL_SECONDS=10 bash "$GUARD" decide stuck 980 1000)"
# F: a non-integer STUCK_MODAL_SECONDS must fall back to the default (not error
# the -ge comparison and short-circuit recovery). 200s elapsed >= 120 -> act.
assert_eq "decide: invalid STUCK_MODAL_SECONDS falls back to default" "act" \
  "$(STUCK_MODAL_SECONDS=garbage bash "$GUARD" decide stuck 800 1000)"

# ---------------------------------------------------------------------------
# (e) Model-id sanitization (W1) — safe to interpolate into the respawn string
# ---------------------------------------------------------------------------
echo ""
echo "(e) Model-id sanitization"
assert_eq "sanitize: legit bracketed model id is preserved" "claude-opus-4-8[1m]" \
  "$(bash "$GUARD" sanitize-model 'claude-opus-4-8[1m]')"
SAN="$(bash "$GUARD" sanitize-model "claude'; rm -rf / #")"
case "$SAN" in
  *"'"*|*";"*|*" "*|*"/"*|*'$'*|*'`'*|*'#'*) fail "sanitize: shell metacharacter survived: $SAN" ;;
  *) pass "sanitize: shell metacharacters stripped ($SAN)" ;;
esac

# ---------------------------------------------------------------------------
# (f) F1 — a missing state dir is created (no flock defer-forever, cold install)
# ---------------------------------------------------------------------------
echo ""
echo "(f) State-dir auto-create"
# CHANNELS_SESSION points at a non-existent session so the guard no-ops at the
# has-session check WITHOUT touching any real pane; the mkdir runs before that.
TMP_F1="$(mktemp -d)"; NOSTORE="$TMP_F1/sub"   # NOSTORE does not exist yet
CHANNELS_SESSION="nonexistent-modal-guard-test-channels" STUCK_MODAL_STATE_DIR="$NOSTORE" \
  bash "$GUARD" >/dev/null 2>&1
[ -d "$NOSTORE" ] && pass "F1: run_guard creates a missing state dir (lock can't defer forever)" \
  || fail "F1: missing state dir not created — exec 9> on the lock would fail and defer recovery"
rm -rf "$TMP_F1"

# ---------------------------------------------------------------------------
# (g) CHATID0 — alert_owner resolves the owner chat, refusing the "0"
# placeholder and falling back to a paired access.json. Needs a throwaway
# INSTALL_DIR (derived from $0) with its own scripts/ + .claude/channels copy,
# and a curl stub via the test-only `alert-owner-test` subcommand.
# ---------------------------------------------------------------------------
echo ""
echo "(g) CHATID0 owner-chat resolution"
GBASE="$(mktemp -d)"
mkdir -p "$GBASE/bin" "$GBASE/home"
cat > "$GBASE/bin/curl" <<'STUB'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    chat_id=*) echo "SEEN_CHAT_ID:${a#chat_id=}" >> "$CURL_LOG" ;;
  esac
done
printf '{"ok":true,"result":{"message_id":1}}'
STUB
chmod +x "$GBASE/bin/curl"

G1="$GBASE/inst1"; mkdir -p "$G1/store" "$G1/.claude/channels/telegram" "$G1/scripts/lib"
cp "$INSTALL_DIR/scripts/stuck-modal-guard.sh" "$G1/scripts/"
cp "$INSTALL_DIR/scripts/lib/owner-chat.sh" "$G1/scripts/lib/"
cp "$INSTALL_DIR/scripts/lib/send-telegram.sh" "$G1/scripts/lib/"
printf 'ALLOWED_CHAT_ID=0\n' > "$G1/.env"
printf 'TELEGRAM_BOT_TOKEN=faketoken\n' > "$G1/.claude/channels/telegram/.env"
printf '{"allowFrom":["8888888"]}\n' > "$G1/.claude/channels/telegram/access.json"
CURL_LOG="$G1/curl.log"; : > "$CURL_LOG"
(cd "$G1" && HOME="$GBASE/home" PATH="$GBASE/bin:$PATH" CURL_LOG="$CURL_LOG" bash scripts/stuck-modal-guard.sh alert-owner-test "probe" >/dev/null 2>&1)
if grep -q "SEEN_CHAT_ID:8888888" "$CURL_LOG" 2>/dev/null; then
  pass "CHATID0: ALLOWED_CHAT_ID=0 + paired access.json -> alerts the real resolved id"
else
  fail "CHATID0: ALLOWED_CHAT_ID=0 + paired access.json -> expected chat_id=8888888, log: $(cat "$CURL_LOG" 2>/dev/null)"
fi

G2="$GBASE/inst2"; mkdir -p "$G2/store" "$G2/scripts/lib"
cp "$INSTALL_DIR/scripts/stuck-modal-guard.sh" "$G2/scripts/"
cp "$INSTALL_DIR/scripts/lib/owner-chat.sh" "$G2/scripts/lib/"
cp "$INSTALL_DIR/scripts/lib/send-telegram.sh" "$G2/scripts/lib/"
printf 'ALLOWED_CHAT_ID=0\n' > "$G2/.env"
CURL_LOG2="$G2/curl.log"; : > "$CURL_LOG2"
(cd "$G2" && HOME="$GBASE/home" PATH="$GBASE/bin:$PATH" CURL_LOG="$CURL_LOG2" bash scripts/stuck-modal-guard.sh alert-owner-test "probe" >/dev/null 2>&1)
if [ ! -s "$CURL_LOG2" ]; then
  pass "CHATID0: ALLOWED_CHAT_ID=0, no access.json -> no send attempted"
else
  fail "CHATID0: ALLOWED_CHAT_ID=0, no access.json -> unexpected send: $(cat "$CURL_LOG2")"
fi
if grep -q "SEEN_CHAT_ID:0" "$CURL_LOG2" 2>/dev/null; then
  fail "CHATID0: the '0' placeholder must never reach curl"
else
  pass "CHATID0: the '0' placeholder never reaches curl"
fi
rm -rf "$GBASE"

# ---------------------------------------------------------------------------
# (h) MODELCONFIRM1005 -- macOS
# ---------------------------------------------------------------------------
echo ""
echo "(h) macOS: the Switch-model dialog is stuck, mtime is portable"

# The pane exactly as captured from the live main session on 2026-10-05: the
# CLI's confirmation after a /model. No idle footer, no live turn -> stuck, so
# the guard (now also scheduled on macOS) would close it.
SWITCH_MODEL='← telegram · 7380188614: Itt vagy?
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Switch model?
   Your next response will be slower and use more tokens
   This conversation is cached for the current model. Switching to Sonnet 5.5
   means the full history gets re-read on your next message.
   ❯ 1. Yes, switch to Sonnet 5.5
     2. No, go back'
assert_eq "the Switch-model confirmation classifies as stuck" "stuck" "$(classify "$SWITCH_MODEL")"

# `stat -c %Y` is GNU-only; on macOS it failed and every stamp read as 0, so
# the shared respawn grace and the backoff never held. The helper must give
# the real mtime on both, and 0 for a missing file.
MT_DIR="$(mktemp -d)"
TZ=UTC touch -t 202610050419.35 "$MT_DIR/stamp"
assert_eq "mtime: the real epoch of a stamp (GNU or BSD stat)" "1791173975" "$(bash "$GUARD" mtime "$MT_DIR/stamp")"
assert_eq "mtime: a missing file is 0" "0" "$(bash "$GUARD" mtime "$MT_DIR/nope")"
assert_eq "no GNU-only 'stat -c' call is left outside the helper" "1" "$(grep -cE '^[^#]*stat -c' "$GUARD" | tr -d ' ')"
rm -rf "$MT_DIR"

# ---------------------------------------------------------------------------
# (i) #1694 review -- automatic recovery is opt-in (STUCK_MODAL_MODE)
# ---------------------------------------------------------------------------
echo ""
echo "(i) Mode: log by default, recovery only with act"

# Resolution, in a throwaway install (its own .env), so the repo's .env never leaks in.
MI="$(mktemp -d)"
mkdir -p "$MI/scripts/lib"
cp "$GUARD" "$MI/scripts/stuck-modal-guard.sh"
cp "$INSTALL_DIR"/scripts/lib/*.sh "$MI/scripts/lib/"
MG="$MI/scripts/stuck-modal-guard.sh"
mode_of() { env -u STUCK_MODAL_MODE ${1:+STUCK_MODAL_MODE="$1"} bash "$MG" mode; }
assert_eq "no setting anywhere -> log" "log" "$(mode_of '')"
assert_eq "env act -> act" "act" "$(mode_of act)"
assert_eq "env ALERT (any case) -> alert" "alert" "$(mode_of ALERT)"
assert_eq "a typo never turns recovery on -> log" "log" "$(mode_of acct)"
printf 'MAIN_AGENT_ID=x\nSTUCK_MODAL_MODE="alert"\n' > "$MI/.env"
assert_eq ".env (quoted) -> alert" "alert" "$(mode_of '')"
assert_eq "env wins over .env" "off" "$(mode_of off)"
rm -rf "$MI"

assert_eq "mode_action act -> recover" "recover" "$(bash "$GUARD" mode-action act 0)"
assert_eq "mode_action log, first time -> report" "report" "$(bash "$GUARD" mode-action log 0)"
assert_eq "mode_action log, already reported -> skip" "skip" "$(bash "$GUARD" mode-action log 1)"
assert_eq "mode_action alert, first time -> report" "report" "$(bash "$GUARD" mode-action alert 0)"
assert_eq "mode_action off -> skip" "skip" "$(bash "$GUARD" mode-action off 0)"
assert_eq "no owner alert names /mcp any more" "0" "$(grep -cE 'alert_owner ".*/mcp' "$GUARD" | tr -d ' ')"

# Behaviour, end to end, against a tmux stub: the captured "Switch model?" pane,
# a confirm window that has already elapsed. log/alert must send NO key and NO
# respawn; act must start recovery. Hermetic: stub tmux first on PATH, state
# dir and session are throwaway, TELEGRAM_STATE_DIR is an empty dir: no token is
# ever found, the alert path only logs (TG_ENV is derived inside the guard).
SB="$(mktemp -d)"
mkdir -p "$SB/bin" "$SB/store" "$SB/tg"
cat > "$SB/bin/tmux" <<STUB
#!/bin/bash
case "\$1" in
  has-session) exit 0 ;;
  capture-pane) printf '%s\n' "\$(cat "$SB/pane")" ;;
  *) echo "\$*" >> "$SB/tmux.calls" ;;
esac
exit 0
STUB
chmod +x "$SB/bin/tmux"
printf '%s' "$SWITCH_MODEL" > "$SB/pane"
run_live() {  # $1 = mode
  : > "$SB/tmux.calls"
  PATH="$SB/bin:$PATH" STUCK_MODAL_MODE="$1" STUCK_MODAL_STATE_DIR="$SB/store" \
    CHANNELS_SESSION=sbx-channels STUCK_MODAL_SECONDS=1 TELEGRAM_STATE_DIR="$SB/tg" \
    bash "$GUARD" 2>&1
}
for m in log alert; do
  rm -f "$SB/store/".stuck-modal-*
  echo "$(( $(date +%s) - 300 ))" > "$SB/store/.stuck-modal-firstseen"
  OUT="$(run_live "$m")"
  assert_eq "$m: no key and no respawn sent to the pane" "0" "$(wc -l < "$SB/tmux.calls" | tr -d ' ')"
  case "$OUT" in *"mode=$m"*) pass "$m: the stuck pane is logged with its mode" ;; *) fail "$m: no mode log line ($OUT)" ;; esac
done
# log reports once per episode; alert retries until an alert is delivered
rm -f "$SB/store/".stuck-modal-*
echo "$(( $(date +%s) - 300 ))" > "$SB/store/.stuck-modal-firstseen"
run_live log >/dev/null
OUT="$(run_live log)"
assert_eq "log: the second tick of the same episode is silent" "" "$OUT"
rm -f "$SB/store/".stuck-modal-*
echo "$(( $(date +%s) - 300 ))" > "$SB/store/.stuck-modal-firstseen"
run_live alert >/dev/null
OUT="$(run_live alert)"
case "$OUT" in *"ALERT"*) pass "alert: an undelivered alert is retried on the next tick" ;; *) fail "alert: no retry ($OUT)" ;; esac
# act: recovery starts (Escape into the pane)
rm -f "$SB/store/".stuck-modal-*
echo "$(( $(date +%s) - 300 ))" > "$SB/store/.stuck-modal-firstseen"
run_live act >/dev/null
case "$(cat "$SB/tmux.calls")" in *"Escape"*) pass "act: recovery starts with Escape" ;; *) fail "act: no Escape sent" ;; esac
# off: nothing at all, not even a capture
: > "$SB/tmux.calls"
OUT="$(PATH="$SB/bin:$PATH" STUCK_MODAL_MODE=off STUCK_MODAL_STATE_DIR="$SB/store" CHANNELS_SESSION=sbx-channels bash "$GUARD" 2>&1)"
assert_eq "off: no output" "" "$OUT"
assert_eq "off: no pane call" "0" "$(wc -l < "$SB/tmux.calls" | tr -d ' ')"
rm -rf "$SB"

# ---------------------------------------------------------------------------
echo ""
echo "======================="
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
