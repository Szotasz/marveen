#!/bin/bash
# Contract tests for the /rename readiness gate in scripts/channels.sh
# (RENAMEREADY1010).
#
# Origin: after the 12 s startup guard the script sent "/rename <name>" + Enter
# unconditionally. A trust dialog that painted after the guard's window got the
# text AND the Enter; on 2.1.252+ the cursor starts on "No, exit", so claude
# quit and the supervise loop relaunched into the same race. The gate must:
#   - never type /rename into a trust/bypass dialog, and answer the dialog with
#     the startup guard's own helper (cursor-aware, TRUSTGATE901),
#   - type /rename only into a ready, dialog-free pane,
#   - give up after a bounded wait and log one line instead of typing blind.
# The gate lives below the launch gate (LAUNCHGATE1008 pins the region above it
# free of send-keys), so there is no seam: like channels-rapid-exit-count, the
# test lifts the script's OWN function text (send_rename_when_ready,
# wait_for_rename_ready, rename_pane_verdict, _answer_accept_dialog,
# probe_pane_input_state, pane_dead_detected) out of channels.sh and runs it with $TMUX pointing at
# a fake that replays pane frames and logs every call, and a stub
# pane-state module (CHANNELS_PANE_STATE_JS) so the idle verdict is
# deterministic. channels.sh itself is never executed; nothing here touches a
# real tmux server or claude. CHANNELS_BIN points the suite at a copy
# (mutation check: it must go red when the gate is bypassed).
# Because the bodies are lifted, the call site is pinned in the source instead:
# exactly one call after the startup guard loop, with the failures-log path, and
# no "/rename" send-keys anywhere outside send_rename_when_ready. Every case
# asserts the exact transcript of tmux and sleep calls (argv by argv), and a
# fake-tmux runaway guard turns an unbounded wait into a failure, not a hang.
# Run: bash scripts/__tests__/channels-rename-ready.test.sh

set -u

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CHANNELS="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# Lift the functions under test out of the script text.
LIB="$TMPD/lib.sh"
: > "$LIB"
for fn in probe_pane_input_state pane_dead_detected _answer_accept_dialog rename_pane_verdict wait_for_rename_ready send_rename_when_ready; do
  body="$(awk -v f="$fn" '$0 == f "() {" {on=1} on {print} on && $0 == "}" {exit}' "$CHANNELS")"
  if [ -z "$body" ]; then
    echo "  FAIL: could not find $fn() in $CHANNELS (renamed? then this test is blind)"
    echo "passed: $PASS  failed: $((FAIL + 1))"
    exit 1
  fi
  printf '%s\n' "$body" >> "$LIB"
done

echo "channels.sh /rename readiness gate"
echo "=================================="

# --- source pins: the call site and the absence of any blind send --------------
# The functions are lifted, so a reverted call site (the pre-fix blind
# `send-keys ... "/rename ..." Enter`) or a removed call would otherwise stay green.
# Each lifted function is defined exactly once (bash runs the LAST definition,
# the lift takes the first).
for fn in pane_dead_detected _answer_accept_dialog rename_pane_verdict wait_for_rename_ready send_rename_when_ready; do
  n="$(grep -cE "^[[:space:]]*(function[[:space:]]+)?${fn}[[:space:]]*\(\)" "$CHANNELS")"
  if [ "$n" = "1" ]; then pass "pin: $fn defined exactly once"; else fail "pin: $fn defined exactly once" 1 "$n"; fi
done
# Non-comment lines outside the send_rename_when_ready body, with line numbers.
OUTSIDE="$(awk '$0 == "send_rename_when_ready() {" {skip=1} !skip && $0 !~ /^[[:space:]]*#/ {print NR ":" $0} skip && $0 == "}" {skip=0}' "$CHANNELS")"
hits="$(printf '%s\n' "$OUTSIDE" | grep -E 'send-keys.*/rename' || true)"
if [ -z "$hits" ]; then pass "pin: no /rename send-keys outside send_rename_when_ready"
else fail "pin: no /rename send-keys outside send_rename_when_ready" none "$(printf '%s' "$hits" | head -2)"; fi
calls="$(printf '%s\n' "$OUTSIDE" | grep -E '^[0-9]+:[[:space:]]*send_rename_when_ready([[:space:]]|$)' || true)"
ncalls="$(printf '%s' "$calls" | grep -c . || true)"
if [ "$ncalls" = "1" ]; then pass "pin: exactly one call of send_rename_when_ready"; else fail "pin: exactly one call of send_rename_when_ready" 1 "$ncalls"; fi
EXPECTED_CALL='send_rename_when_ready "${_bot_name}" "$INSTALL_DIR/store/channels-failures.log" || true'
if [ "${calls#*:}" = "$EXPECTED_CALL" ]; then pass "pin: the call passes the bot name and store/channels-failures.log"
else fail "pin: the call passes the bot name and store/channels-failures.log" "$EXPECTED_CALL" "${calls#*:}"; fi
call_line="${calls%%:*}"
loop_end="$(grep -n '^unset _eperm_restarted$' "$CHANNELS" | head -1 | cut -d: -f1)"
gate_end="$(grep -nxF '# LAUNCHGATE1008-END: everything below launches.' "$CHANNELS" | head -1 | cut -d: -f1)"
case "$call_line:$loop_end:$gate_end" in
  *[!0-9:]*|:*|*::*|*:) fail "pin: the call comes after the startup guard loop" "line numbers" "call=$call_line loop_end=$loop_end gate=$gate_end" ;;
  *) if [ "$call_line" -gt "$loop_end" ] && [ "$loop_end" -gt "$gate_end" ]; then pass "pin: the call comes after the startup guard loop"
     else fail "pin: the call comes after the startup guard loop" "call > $loop_end > $gate_end" "$call_line"; fi ;;
esac
# Placement of the call among the statements between the guard loop and the
# supervise loop, both bounds:
#  - after the time-sensitive ones, which must keep their pre-gate timing: the
#    keep-alive baseline and the respawn stamp (the watchdog and the channel
#    monitor read the stamp as "booting, leave it alone") and START_TS (the
#    rapid-exit window); the bounded wait (up to ~20 s) must not delay them;
#  - before anything later that types into the pane: the post-init /mcp unlock
#    subshell (spawn line and its first send-keys), so the two never overlap
#    on one input line.
ka_line="$(grep -nxF 'touch "$INSTALL_DIR/store/.channel-keepalive"' "$CHANNELS" | head -1 | cut -d: -f1)"
stamp_line="$(grep -nxF 'date +%s > "$INSTALL_DIR/store/.channel-last-respawn"' "$CHANNELS" | head -1 | cut -d: -f1)"
start_line="$(grep -nxF 'START_TS=$(date +%s)' "$CHANNELS" | head -1 | cut -d: -f1)"
# first subshell opener and first non-comment send-keys after the guard loop
sub_line="$(awk -v a="${loop_end:-0}" 'NR > a && $0 == "(" {print NR; exit}' "$CHANNELS")"
keys_line="$(awk -v a="${loop_end:-0}" 'NR > a && $0 !~ /^[[:space:]]*#/ && /send-keys/ {print NR; exit}' "$CHANNELS")"
for pair in "keep-alive baseline|$ka_line" "respawn stamp|$stamp_line" "START_TS|$start_line"; do
  what="${pair%%|*}"; ln="${pair#*|}"
  case "$loop_end:$ln:$call_line" in
    *[!0-9:]*|:*|*::*|*:) fail "pin: $what taken after the guard loop and before the rename wait" "line numbers" "loop_end=$loop_end $what=$ln call=$call_line" ;;
    *) if [ "$loop_end" -lt "$ln" ] && [ "$ln" -lt "$call_line" ]; then pass "pin: $what taken after the guard loop and before the rename wait"
       else fail "pin: $what taken after the guard loop and before the rename wait" "$loop_end < $what < $call_line" "$ln"; fi ;;
  esac
done
for pair in "post-init unlock subshell spawn|$sub_line" "first later send-keys|$keys_line"; do
  what="${pair%%|*}"; ln="${pair#*|}"
  case "$call_line:$ln" in
    *[!0-9:]*|:*|*:) fail "pin: rename wait comes before the $what" "line numbers" "call=$call_line $what=$ln" ;;
    *) if [ "$call_line" -lt "$ln" ]; then pass "pin: rename wait comes before the $what"
       else fail "pin: rename wait comes before the $what" "call < $ln" "$call_line"; fi ;;
  esac
done
# The name is still set at the call: exactly one _bot_name assignment and one
# unset (non-comment), with assignment < call < unset.
bn_set="$(grep -nE '^[[:space:]]*_bot_name=' "$CHANNELS" | cut -d: -f1 | tr '\n' ' ' | sed 's/ $//')"
bn_unset="$(grep -nE '^[[:space:]]*unset([[:space:]].*)?[[:space:]]_bot_name([[:space:]]|$)' "$CHANNELS" | cut -d: -f1 | tr '\n' ' ' | sed 's/ $//')"
case "$bn_set:$call_line:$bn_unset" in
  *[!0-9:]*|:*|*::*|*:) fail "pin: _bot_name assigned once before the call and unset once after it" "one line each" "set=[$bn_set] call=$call_line unset=[$bn_unset]" ;;
  *) if [ "$bn_set" -lt "$call_line" ] && [ "$call_line" -lt "$bn_unset" ]; then pass "pin: _bot_name assigned once before the call and unset once after it"
     else fail "pin: _bot_name assigned once before the call and unset once after it" "set < $call_line < unset" "set=$bn_set unset=$bn_unset"; fi ;;
esac
# Call log: the fake tmux and the fake sleep append EVERY invocation to one
# file, one line per call, each argv element bracketed on its own
# ([capture-pane][-t][=test-channels:][-p], [send-keys][-t][=test-channels:]
# [/rename bot][Enter], [sleep][2]). Every case asserts the exact full
# transcript, so argument boundaries, targets, extra or missing keys, captures
# and sleeps, and their order are all pinned at once.
#
# Fake tmux: frames live in $FRAMES/1, $FRAMES/2, ...; every plain capture
# advances to the next frame (the last one repeats), the coloured (-e) capture
# that follows it returns the same frame. A GHOST_SLOT token in a frame stands
# for the dim placeholder Claude Code paints into an empty input box: the plain
# capture shows its text as-is, only the -e capture wraps it in SGR 2 (dim). A
# capture aimed at any target other than the exact-match "=test-channels:"
# returns nothing and fails, like tmux does for a missing session.
# has-session and list-panes -F '#{pane_dead}' answer for the frame the next
# plain capture would show: SESSION_GONE in it -> has-session fails, PANE_DEAD
# in it -> pane_dead is 1.
FAKE="$TMPD/tmux"
cat > "$FAKE" <<'SH'
#!/bin/bash
{ printf '[%s]' "$@"; echo; } >> "$CALLS"
cmd="$1"; shift
tgt=""; prev=""
for a in "$@"; do [ "$prev" = "-t" ] && tgt="$a"; prev="$a"; done
next_frame() {
  local i n
  i=$(( $(cat "$FRAMES/.idx" 2>/dev/null || echo 0) + 1 ))
  n=$(ls "$FRAMES" | grep -c '^[0-9]*$')
  [ "$i" -gt "$n" ] && i=$n
  cat "$FRAMES/$i"
}
case "$cmd" in
  has-session)
    [ "$tgt" = "=test-channels:" ] || exit 1
    next_frame | grep -q SESSION_GONE && exit 1
    ;;
  list-panes)
    [ "$tgt" = "=test-channels:" ] || exit 1
    if next_frame | grep -q PANE_DEAD; then echo 1; else echo 0; fi
    ;;
  capture-pane)
    [ "$tgt" = "=test-channels:" ] || exit 1
    idx=$(cat "$FRAMES/.idx" 2>/dev/null || echo 0)
    case " $* " in
      *" -e "*) ;;
      *) idx=$((idx + 1)); echo "$idx" > "$FRAMES/.idx"; echo x >> "$FRAMES/.plain-captures" ;;
    esac
    # Runaway guard: an unbounded wait must fail the case, not hang the suite
    # (the most a bounded case takes is 10 plain captures, the default limit).
    if [ "$(grep -c . "$FRAMES/.plain-captures" 2>/dev/null)" -gt 25 ]; then
      touch "$FRAMES/.runaway"; kill -TERM "$CASE_PID" 2>/dev/null; exit 1
    fi
    [ "$idx" -lt 1 ] && idx=1
    n=$(ls "$FRAMES" | grep -c '^[0-9]*$')
    [ "$idx" -gt "$n" ] && idx=$n
    ghost='Try "refactor <filepath>"'
    case " $* " in
      *" -e "*) ghost="$(printf '\033[2m')$ghost$(printf '\033[0m')" ;;
    esac
    sed "s/GHOST_SLOT/$ghost/" "$FRAMES/$idx"
    ;;
esac
exit 0
SH
chmod +x "$FAKE"

# Fake sleep: logs into the same call log and returns at once, so the
# cadence (default 2 s, and the sleep after an answered dialog) is asserted
# without waiting for it.
mkdir -p "$TMPD/bin"
printf '#!/bin/bash\n{ printf "[%%s]" sleep "$@"; echo; } >> "$CALLS"\nexit 0\n' > "$TMPD/bin/sleep"
chmod +x "$TMPD/bin/sleep"

# Stub pane-state: "idle" when the frame carries the IDLE_PROMPT marker, or when
# the box held only a DIM placeholder (it needs the SGR 2 bytes of the coloured
# capture: fed the plain capture, the placeholder reads as text in the box, as
# the real module does); PARKED_TEXT or placeholder text -> "typing"
# ("parked:..."), UNKNOWN_SCREEN -> "unknown", "busy" otherwise.
STUB_JS="$TMPD/pane-state.js"
cat > "$STUB_JS" <<'JS'
const ansi = /\x1b\[[0-9;]*m/g
module.exports = {
  stripAllAnsi: (s) => s.replace(ansi, ''),
  stripGhostSuggestion: (s) => s.replace(/\x1b\[2m[^\x1b]*\x1b\[0m/g, '').replace(ansi, ''),
  idleConsideringDimGhost: (plain, view) => plain.includes('IDLE_PROMPT')
    || (view !== plain && /^> *$/m.test(view)),
  detectPaneState: (plain) => plain.includes('PARKED_TEXT') || plain.includes('Try "') ? 'typing'
    : plain.includes('UNKNOWN_SCREEN') ? 'unknown' : 'busy',
  parkedInputText: (view) => view.includes('PARKED_TEXT') ? 'hello'
    : (view.match(/^> (Try .*)$/m) || [, ''])[1],
}
JS

TRUST_CURSOR_ON_YES='Quick safety check: is this a project you trust?

 ❯ Yes, I trust this folder
   No, exit'
TRUST_CURSOR_ON_NO='Quick safety check: is this a project you trust?

 ❯ No, exit
   Yes, I trust this folder'
TRUST_OLD='Do you trust the files in this folder?

   1. Yes, proceed
   2. No, exit'
BYPASS='WARNING: Claude Code running in Bypass Permissions mode

 ❯ No, exit
   Yes, I accept'
READY='Listening for channel messages from: plugin:telegram
> IDLE_PROMPT'
BANNER='Listening for channel messages from: plugin:telegram'
BANNER_ONLY="$BANNER
>"
BUSY='* Working... (esc to interrupt)'

# run_case <frames...>: sets GOT (stdout), CALLS_OUT (the call log), LOG_OUT.
# Env: TRIES (default 4; "default" = no TRIES/SLEEP override, the script's own
# limits apply), PANE_JS (default the stub), LOG_SEED (a line written to the
# failures log before the run; the log is shared and append-only).
run_case() {
  FRAMES="$TMPD/frames"; CALLS="$TMPD/calls"; LOG="$TMPD/failures.log"
  rm -rf "$FRAMES" "$LOG"; mkdir -p "$FRAMES"; : > "$CALLS"
  if [ -n "${LOG_SEED:-}" ]; then printf '%s\n' "$LOG_SEED" > "$LOG"; fi
  local i=0 f limits
  for f in "$@"; do i=$((i + 1)); printf '%s\n' "$f" > "$FRAMES/$i"; done
  limits=(CHANNELS_RENAME_READY_TRIES="${TRIES:-4}" CHANNELS_RENAME_READY_SLEEP=0)
  [ "${TRIES:-}" = default ] && limits=()
  GOT="$(env -u CHANNELS_RENAME_READY_TRIES -u CHANNELS_RENAME_READY_SLEEP \
    FRAMES="$FRAMES" CALLS="$CALLS" TMUX="$FAKE" SESSION=test-channels \
    INSTALL_DIR="$TMPD" CHANNELS_PANE_STATE_JS="${PANE_JS:-$STUB_JS}" PATH="$TMPD/bin:$PATH" \
    ${limits[@]+"${limits[@]}"} \
    bash -c 'CASE_PID=$$; export CASE_PID; . "$1"; if send_rename_when_ready bot "$2"; then echo sent; else echo skipped; fi' _ "$LIB" "$LOG" 2>/dev/null)"
  if [ -e "$FRAMES/.runaway" ]; then fail "case stops on its own (bounded wait)" "<= 25 captures" "runaway, killed"; fi
  CALLS_OUT="$(cat "$CALLS")"
  LOG_OUT="$(cat "$LOG" 2>/dev/null || true)"
}

# Golden transcripts. golden <token...> prints one call-log line per token:
#   try    -> the liveness checks (has-session, pane_dead), the plain capture,
#             then the coloured (-e) capture
#   gone   -> has-session only (it failed: the wait stops there)
#   dead   -> has-session, then the pane_dead query (it said 1: the wait stops)
#   s<N>   -> [sleep][N]
#   k:<x>  -> [send-keys][-t][=test-channels:]<x>   (x = bracketed keys)
#   rename -> [send-keys][-t][=test-channels:][/rename bot][Enter]
#   <n>x   -> repeat the following token group up to the next "/" n times
golden() {
  local out="" line t n group
  while [ $# -gt 0 ]; do
    t="$1"; shift
    case "$t" in
      *x)
        n="${t%x}"; group=()
        while [ $# -gt 0 ] && [ "$1" != / ]; do group+=("$1"); shift; done
        [ $# -gt 0 ] && shift
        while [ "$n" -gt 0 ]; do line="$(golden "${group[@]}")"; out="${out:+$out
}$line"; n=$((n - 1)); done
        continue ;;
      try) line='[has-session][-t][=test-channels:]
[list-panes][-t][=test-channels:][-F][#{pane_dead}]
[capture-pane][-t][=test-channels:][-p]
[capture-pane][-t][=test-channels:][-e][-p]' ;;
      gone) line='[has-session][-t][=test-channels:]' ;;
      dead) line='[has-session][-t][=test-channels:]
[list-panes][-t][=test-channels:][-F][#{pane_dead}]' ;;
      s*) line="[sleep][${t#s}]" ;;
      k:*) line="[send-keys][-t][=test-channels:]${t#k:}" ;;
      rename) line='[send-keys][-t][=test-channels:][/rename bot][Enter]' ;;
      *) line="[golden: unknown token $t]" ;;
    esac
    out="${out:+$out
}$line"
  done
  printf '%s' "$out"
}
RENAME=rename
ENTER='k:[Enter]'
DOWN_ENTER='k:[Down] s1 k:[Enter]'

expect_eq() { if [ "$3" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }
expect_has() { case "$3" in *"$2"*) pass "$1";; *) fail "$1" "contains [$2]" "$3";; esac; }
# expect_calls <label> <golden tokens...>: the exact full call transcript.
expect_calls() {
  local label="$1"; shift
  local want; want="$(golden "$@")"
  if [ "$CALLS_OUT" = "$want" ]; then pass "$label -> exact call transcript"
  else fail "$label -> exact call transcript" "
$want
" "
$CALLS_OUT
"; fi
}

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not found (the gate's idle probe needs it)"
  exit 0
fi

# (b) ready prompt -> one capture pair, then /rename + Enter as two argv
# elements (a single "/rename bot Enter" string or a split "/rename" "bot"
# would type the wrong text)
run_case "$READY"
expect_eq    "ready pane -> sent"                          sent            "$GOT"
expect_calls "ready pane"                                  try $RENAME
expect_eq    "ready pane -> no skip line"                  ""              "$LOG_OUT"

# fresh pane whose empty box shows the dim placeholder: idle only on the
# coloured (-e) capture, so this pins that the probe reads that capture
run_case "$BANNER
> GHOST_SLOT"
expect_eq    "placeholder in box -> sent"                  sent            "$GOT"
expect_calls "placeholder in box, renamed on the first try" try $RENAME

# (a) late trust dialog -> answered first, then the inter-try sleep (the TUI
# must repaint before the next capture), /rename only after the pane is ready
run_case "$TRUST_CURSOR_ON_YES" "$READY"
expect_eq    "late trust dialog, then ready -> sent"       sent            "$GOT"
expect_calls "late trust dialog, cursor on Yes"            try $ENTER s0 try $RENAME

# (a) the regression: dialog stays -> /rename NEVER typed into it
run_case "$TRUST_CURSOR_ON_NO"
expect_eq    "persistent dialog -> skipped"                skipped         "$GOT"
expect_calls "persistent dialog, cursor on No (Down+Enter each try, no /rename)" 4x try $DOWN_ENTER s0 /
expect_has   "persistent dialog -> skip line names the dialog" "verdict: dialog" "$LOG_OUT"

# old-style trust dialog in an unknown shape (no cursor glyph): no keys at all
run_case "$TRUST_OLD"
expect_eq    "unknown-shape dialog -> skipped"             skipped         "$GOT"
expect_calls "unknown-shape dialog (no keys)"              4x try s0 /

# old-panel trust dialog (pre-2.1.246 anchor) over an idle-looking line:
# still a dialog, never typed into
run_case "$TRUST_OLD
IDLE_PROMPT"
expect_calls "old-panel dialog + idle marker (no keys)"    4x try s0 /
expect_has   "old-panel dialog + idle marker -> skip names the dialog" "verdict: dialog" "$LOG_OUT"
# ...and with the cursor on its Yes line it is answered, then renamed
run_case "Do you trust the files in this folder?

 ❯ Yes, proceed
   No, exit" "$READY"
expect_calls "old-panel dialog, cursor on Yes"             try $ENTER s0 try $RENAME

# bypass dialog late -> answered, then rename
run_case "$BYPASS" "$READY"
expect_eq    "late bypass dialog, then ready -> sent"      sent            "$GOT"
expect_calls "late bypass dialog"                          try $DOWN_ENTER s0 try $RENAME

# a dialog wins over an idle-looking input line
run_case "$TRUST_CURSOR_ON_NO
IDLE_PROMPT"
expect_calls "dialog + idle marker (answered, no /rename)" 4x try $DOWN_ENTER s0 /

# a cursor glyph outside a dialog is NOT a dialog: no key may be sent (the
# answer helper would press Enter on "Yes please" and submit the parked text)
TRIES=3 run_case "$BANNER
❯ Yes please"
expect_eq    "banner + '❯ Yes please' in the box -> skipped" skipped       "$GOT"
expect_calls "banner + '❯ Yes please' in the box (no keys)" 3x try s0 /
TRIES=3 run_case "$BANNER
❯ No, exit
  Yes, sure"
expect_calls "banner + '❯ No, exit' over 'Yes, sure', not a dialog (no keys)" 3x try s0 /

# claude died right after launch (remain-on-exit keeps the dead pane) or the
# session is gone: the wait stops at once, no capture, no sleep, no key, so
# the supervise loop sees the exit as early as before the gate (START_TS is
# already taken; waiting out the tries would push a startup crash toward the
# 30 s rapid-exit threshold).
run_case "PANE_DEAD"
expect_eq    "dead pane -> skipped"                        skipped         "$GOT"
expect_calls "dead pane on the first try (stops at once)"  dead
expect_has   "dead pane -> skip line names it"             "verdict: dead" "$LOG_OUT"
run_case "SESSION_GONE"
expect_eq    "session gone -> skipped"                     skipped         "$GOT"
expect_calls "session gone on the first try (stops at once)" gone
expect_has   "session gone -> skip line names it"          "verdict: gone" "$LOG_OUT"
run_case "$BUSY" "PANE_DEAD"
expect_calls "busy, then the pane dies (stops on the next try)" try s0 dead
run_case "$TRUST_CURSOR_ON_YES" "PANE_DEAD"
expect_calls "dialog answered, then the pane dies (no /rename)" try $ENTER s0 dead

# (c) never ready -> skipped with one log line, nothing typed, bounded. The
# failures log is shared (earlier lines of the same launch live there): the
# skip line is appended, never truncating it.
SEED='earlier launch line (SEEDLINE)'
LOG_SEED="$SEED" TRIES=3 run_case "$BUSY"
expect_eq    "never ready -> skipped"                      skipped         "$GOT"
expect_calls "never ready, bounded to TRIES"               3x try s0 /
expect_eq    "never ready -> exactly one log line"         1               "$(printf '%s\n' "$LOG_OUT" | grep -c 'RENAMEREADY1010')"
expect_eq    "never ready -> earlier log line kept, skip line appended after it" "$SEED|RENAMEREADY1010|2" \
  "$(printf '%s\n' "$LOG_OUT" | sed -n 1p)|$(printf '%s\n' "$LOG_OUT" | sed -n 2p | grep -o RENAMEREADY1010)|$(printf '%s\n' "$LOG_OUT" | grep -c .)"
expect_has   "never ready -> log names the input state"    "input: busy"   "$LOG_OUT"

# the banner alone is not readiness when the probe can measure: only an empty
# input line is (text in the box would be submitted with /rename appended)
for c in "banner + text in box|$BANNER
> PARKED_TEXT|parked:hello" \
         "banner + unknown screen|$BANNER
UNKNOWN_SCREEN|unknown" \
         "banner + busy|$BANNER
$BUSY|busy" \
         "text in box, no banner|> PARKED_TEXT|parked:hello"; do
  label="${c%%|*}"; rest="${c#*|}"; frame="${rest%|*}"; state="${rest##*|}"
  TRIES=3 run_case "$frame"
  expect_eq    "$label -> skipped"                         skipped         "$GOT"
  expect_calls "$label (no keys)"                          3x try s0 /
  expect_has   "$label -> skip line names input: $state"   "verdict: wait, input: $state" "$LOG_OUT"
done

# the script's own limits (no override): 10 tries, 2 s apart
TRIES=default run_case "$BUSY"
expect_eq    "default limits -> skipped"                   skipped         "$GOT"
expect_calls "default limits, 10 tries x 2 s"              10x try s2 /

# busy for a while, then ready -> sent once
run_case "$BUSY" "$BUSY" "$READY"
expect_calls "busy then ready (one /rename)"               try s0 try s0 try $RENAME

# probe cannot measure (no pane-state module): pre-fix banner signal is kept
PANE_JS=/nonexistent/pane-state.js run_case "$BANNER_ONLY"
expect_eq    "unverifiable + banner -> sent"               sent            "$GOT"
expect_calls "unverifiable + banner"                       try $RENAME
PANE_JS=/nonexistent/pane-state.js run_case "$BUSY"
expect_eq    "unverifiable, no banner -> skipped"          skipped         "$GOT"
expect_calls "unverifiable, no banner (no keys)"           4x try s0 /
PANE_JS=/nonexistent/pane-state.js run_case "$TRUST_CURSOR_ON_YES
$BANNER"
expect_calls "unverifiable + banner + dialog (answered, no /rename)" 4x try $ENTER s0 /

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
