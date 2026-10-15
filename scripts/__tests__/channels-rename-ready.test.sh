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
# probe_pane_input_state_bounded, probe_pane_input_state, pane_dead_detected)
# out of channels.sh and runs it with $TMUX pointing at
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
# A probe that never returns is bounded per call (probe_pane_input_state_bounded);
# an outer wall-clock guard in run_case kills a case that still hangs, so a
# regression there fails the case instead of hanging the suite.
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
for fn in probe_pane_input_state pane_dead_detected _answer_accept_dialog rename_pane_verdict probe_pane_input_state_bounded rename_wait_limits wait_for_rename_ready send_rename_when_ready; do
  body="$(awk -v f="$fn" '$0 == f "() {" {on=1} on {print} on && $0 == "}" {exit}' "$CHANNELS")"
  if [ -z "$body" ]; then
    echo "  FAIL: could not find $fn() in $CHANNELS (renamed? then this test is blind)"
    echo "passed: $PASS  failed: $((FAIL + 1))"
    exit 1
  fi
  printf '%s\n' "$body" >> "$LIB"
done

# Two recording wrappers, so the bounds are asserted as values against the
# wait's own clock reading instead of as wall time (a slow runner shifts the
# whole-second clock, not these relations):
#  - the lifted helper runs as __real_probe_pane_input_state_bounded; the
#    wrapper appends "<bound> <time left> <per-call max> [<ms>]" to $BOUNDS per
#    probe call (<time left> and <per-call max> are the wait's own _rr_left and
#    _rr_pb_max at the call; <ms>, the probe's wall time, only with PROBE_MS);
#  - a sleep function appends "<arg> <time left> <interval rounded up>" to
#    $SLEEPS, then runs the fake sleep, so the call log is unchanged.
sed -i.bak 's/^probe_pane_input_state_bounded() {$/__real_probe_pane_input_state_bounded() {/' "$LIB"
cat >> "$LIB" <<'WRAP'
probe_pane_input_state_bounded() {
  local t0=""
  [ -n "${PROBE_MS:-}" ] && t0="$(node -e 'console.log(Date.now())')"
  __real_probe_pane_input_state_bounded "$@"
  printf '%s %s %s%s\n' "$1" "${_rr_left:-?}" "${_rr_pb_max:-?}" \
    "${t0:+ $(( $(node -e 'console.log(Date.now())') - t0 ))}" >> "$BOUNDS"
}
sleep() { printf '%s %s %s\n' "$1" "${_rr_left:-?}" "${_rr_unit:-?}" >> "$SLEEPS"; command sleep "$@"; }
WRAP

echo "channels.sh /rename readiness gate"
echo "=================================="

# --- source pins: the call site and the absence of any blind send --------------
# The functions are lifted, so a reverted call site (the pre-fix blind
# `send-keys ... "/rename ..." Enter`) or a removed call would otherwise stay green.
# Each lifted function is defined exactly once (bash runs the LAST definition,
# the lift takes the first).
for fn in pane_dead_detected _answer_accept_dialog rename_pane_verdict probe_pane_input_state_bounded rename_wait_limits wait_for_rename_ready send_rename_when_ready; do
  n="$(grep -cE "^[[:space:]]*(function[[:space:]]+)?${fn}[[:space:]]*\(\)" "$CHANNELS")"
  if [ "$n" = "1" ]; then pass "pin: $fn defined exactly once"; else fail "pin: $fn defined exactly once" 1 "$n"; fi
done
# The wait probes only through the bounded helper: a direct call would bring
# back the unbounded foreground probe.
WAIT_BODY="$(awk '$0 == "wait_for_rename_ready() {" {on=1} on {print} on && $0 == "}" {exit}' "$CHANNELS")"
nb="$(printf '%s\n' "$WAIT_BODY" | grep -cE '\| probe_pane_input_state_bounded( |\))' || true)"
nr="$(printf '%s\n' "$WAIT_BODY" | grep -cE 'probe_pane_input_state([^_]|$)' || true)"
if [ "$nb:$nr" = "1:0" ]; then pass "pin: wait_for_rename_ready probes only through probe_pane_input_state_bounded"
else fail "pin: wait_for_rename_ready probes only through probe_pane_input_state_bounded" "1 bounded, 0 direct" "$nb bounded, $nr direct"; fi
# ...and the post-init unlock subshell is unchanged: outside the wait it still
# calls probe_pane_input_state directly (3 calls), never the bounded helper.
REST="$(awk '$0 == "wait_for_rename_ready() {" {skip=1} !skip {print} skip && $0 == "}" {skip=0}' "$CHANNELS" | grep -v '^[[:space:]]*#')"
ud="$(printf '%s\n' "$REST" | grep -cE '\| probe_pane_input_state\)' || true)"
ub="$(printf '%s\n' "$REST" | grep -cE '\| probe_pane_input_state_bounded' || true)"
if [ "$ud:$ub" = "3:0" ]; then pass "pin: the unlock subshell still probes directly (3 direct, 0 bounded outside the wait)"
else fail "pin: the unlock subshell still probes directly (3 direct, 0 bounded outside the wait)" "3:0" "$ud:$ub"; fi
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
#    rapid-exit window); the bounded wait (deadline 30 s by default) must
#    not delay them;
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
# without waiting for it. With REAL_SLEEP set it also really sleeps (for the
# case that checks the deadline leaves room for every ordinary try).
mkdir -p "$TMPD/bin"
printf '#!/bin/bash\n{ printf "[%%s]" sleep "$@"; echo; } >> "$CALLS"\n[ -n "${REAL_SLEEP:-}" ] && /bin/sleep "$@"\nexit 0\n' > "$TMPD/bin/sleep"
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

# now_ms: wall clock in milliseconds (node is required by the suite anyway).
now_ms() { node -e 'console.log(Date.now())'; }
# kill_tree <pid>: SIGKILL a process and all its descendants, children first.
kill_tree() {
  local k
  for k in $(/usr/bin/pgrep -P "$1" 2>/dev/null); do kill_tree "$k"; done
  kill -KILL "$1" 2>/dev/null
}

# run_case <frames...>: sets GOT (stdout), CALLS_OUT (the call log), LOG_OUT,
# ELAPSED_MS (wall clock of the case when TIMED is set, else -1).
# Env: TRIES (default 4; "default" = no TRIES/SLEEP override, the script's own
# limits apply), PANE_JS (default the stub), LOG_SEED (a line written to the
# failures log before the run; the log is shared and append-only),
# SLEEP (the interval, default 9: the fake sleep returns at once, so this only
# sets the deadline, 10 s per try, far out of reach of the cases that do not
# test it; those stay independent of the clock), PROBE_MS (time each probe
# call in ms into $BOUNDS), PROBE_TIMEOUT (CHANNELS_RENAME_PROBE_TIMEOUT
# for the case; unset = the script's default), GUARD (outer wall-clock
# guard in s, default 30: a case still running then is killed with its whole
# process tree and fails), ALIGN
# (start the wait right after a whole-second tick, so the whole-second clock
# reads the true elapsed seconds and time-dependent transcripts are exact).
# SECONDS starts at 1000 in every case: in channels.sh the wait runs long after
# the shell started (the startup guard alone takes 12 s), so the deadline must
# be measured from the wait's own start, not from the process start.
run_case() {
  FRAMES="$TMPD/frames"; CALLS="$TMPD/calls"; LOG="$TMPD/failures.log"; BOUNDS="$TMPD/bounds"; : > "$BOUNDS"; SLEEPS="$TMPD/sleeps"; : > "$SLEEPS"
  rm -rf "$FRAMES" "$LOG" "$TMPD/probe-tmp" "$TMPD/aligned-start"; mkdir -p "$FRAMES" "$TMPD/probe-tmp"; : > "$CALLS"
  if [ -n "${LOG_SEED:-}" ]; then printf '%s\n' "$LOG_SEED" > "$LOG"; fi
  local i=0 f limits
  for f in "$@"; do i=$((i + 1)); printf '%s\n' "$f" > "$FRAMES/$i"; done
  limits=(CHANNELS_RENAME_READY_TRIES="${TRIES:-4}" CHANNELS_RENAME_READY_SLEEP="${SLEEP:-9}")
  [ "${TRIES:-}" = default ] && limits=()
  [ -n "${PROBE_TIMEOUT:-}" ] && limits+=(CHANNELS_RENAME_PROBE_TIMEOUT="$PROBE_TIMEOUT")
  local job n t0 hung=0
  t0=0; [ -n "${TIMED:-}" ] && t0="$(now_ms)"
  env -u CHANNELS_RENAME_READY_TRIES -u CHANNELS_RENAME_READY_SLEEP -u CHANNELS_RENAME_PROBE_TIMEOUT \
    FRAMES="$FRAMES" CALLS="$CALLS" BOUNDS="$BOUNDS" SLEEPS="$SLEEPS" PROBE_MS="${PROBE_MS:-}" TMUX="$FAKE" SESSION=test-channels REAL_SLEEP="${REAL_SLEEP:-}" \
    INSTALL_DIR="$TMPD" CHANNELS_PANE_STATE_JS="${PANE_JS:-$STUB_JS}" PATH="$TMPD/bin:$PATH" \
    TMPDIR="$TMPD/probe-tmp" ${limits[@]+"${limits[@]}"} \
    bash -c 'SECONDS=1000
      if [ -n "$3" ]; then _s=$SECONDS; while [ "$SECONDS" = "$_s" ]; do :; done; date +%s > "$3"; fi
      CASE_PID=$$; export CASE_PID; . "$1"; if send_rename_when_ready bot "$2"; then echo sent; else echo skipped; fi' _ "$LIB" "$LOG" "${ALIGN:+$TMPD/aligned-start}" > "$TMPD/got" 2>/dev/null &
  job=$!
  n=0
  while kill -0 "$job" 2>/dev/null; do
    if [ "$n" -ge "$(( ${GUARD:-30} * 10 ))" ]; then hung=1; kill_tree "$job"; break; fi
    /bin/sleep 0.1
    n=$((n + 1))
  done
  wait "$job" 2>/dev/null
  # aligned: measured from the tick the wait started on, not from the launch
  [ -n "${ALIGN:-}" ] && [ -s "$TMPD/aligned-start" ] && t0=$(( $(cat "$TMPD/aligned-start") * 1000 ))
  ELAPSED_MS=-1; [ -n "${TIMED:-}" ] && ELAPSED_MS=$(( $(now_ms) - t0 ))
  GOT="$(cat "$TMPD/got")"
  if [ "$hung" = 1 ]; then fail "case ends within the outer guard" "<= ${GUARD:-30} s" "still running, killed"; fi
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
expect_lacks() { case "$3" in *"$2"*) fail "$1" "no [$2]" "$3";; *) pass "$1";; esac; }
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
expect_calls "late trust dialog, cursor on Yes"            try $ENTER s9 try $RENAME

# (a) the regression: dialog stays -> /rename NEVER typed into it
run_case "$TRUST_CURSOR_ON_NO"
expect_eq    "persistent dialog -> skipped"                skipped         "$GOT"
expect_calls "persistent dialog, cursor on No (Down+Enter each try, no /rename)" 4x try $DOWN_ENTER s9 /
expect_has   "persistent dialog -> skip line names the dialog" "verdict: dialog" "$LOG_OUT"
expect_lacks "persistent dialog -> skip line names no deadline" "wait deadline" "$LOG_OUT"

# old-style trust dialog in an unknown shape (no cursor glyph): no keys at all
run_case "$TRUST_OLD"
expect_eq    "unknown-shape dialog -> skipped"             skipped         "$GOT"
expect_calls "unknown-shape dialog (no keys)"              4x try s9 /

# old-panel trust dialog (pre-2.1.246 anchor) over an idle-looking line:
# still a dialog, never typed into
run_case "$TRUST_OLD
IDLE_PROMPT"
expect_calls "old-panel dialog + idle marker (no keys)"    4x try s9 /
expect_has   "old-panel dialog + idle marker -> skip names the dialog" "verdict: dialog" "$LOG_OUT"
# ...and with the cursor on its Yes line it is answered, then renamed
run_case "Do you trust the files in this folder?

 ❯ Yes, proceed
   No, exit" "$READY"
expect_calls "old-panel dialog, cursor on Yes"             try $ENTER s9 try $RENAME

# bypass dialog late -> answered, then rename
run_case "$BYPASS" "$READY"
expect_eq    "late bypass dialog, then ready -> sent"      sent            "$GOT"
expect_calls "late bypass dialog"                          try $DOWN_ENTER s9 try $RENAME

# a dialog wins over an idle-looking input line
run_case "$TRUST_CURSOR_ON_NO
IDLE_PROMPT"
expect_calls "dialog + idle marker (answered, no /rename)" 4x try $DOWN_ENTER s9 /

# a cursor glyph outside a dialog is NOT a dialog: no key may be sent (the
# answer helper would press Enter on "Yes please" and submit the parked text)
TRIES=3 run_case "$BANNER
❯ Yes please"
expect_eq    "banner + '❯ Yes please' in the box -> skipped" skipped       "$GOT"
expect_calls "banner + '❯ Yes please' in the box (no keys)" 3x try s9 /
TRIES=3 run_case "$BANNER
❯ No, exit
  Yes, sure"
expect_calls "banner + '❯ No, exit' over 'Yes, sure', not a dialog (no keys)" 3x try s9 /

# claude died right after launch (remain-on-exit keeps the dead pane) or the
# session is gone: the wait stops at once, no capture, no sleep, no key, so
# the supervise loop sees the exit as early as before the gate (START_TS is
# already taken; waiting out the tries would push a startup crash toward the
# 30 s rapid-exit threshold).
run_case "PANE_DEAD"
expect_eq    "dead pane -> skipped"                        skipped         "$GOT"
expect_calls "dead pane on the first try (stops at once)"  dead
expect_has   "dead pane -> skip line names it"             "verdict: dead" "$LOG_OUT"
expect_lacks "dead pane -> skip line names no deadline"    "wait deadline" "$LOG_OUT"
run_case "SESSION_GONE"
expect_eq    "session gone -> skipped"                     skipped         "$GOT"
expect_calls "session gone on the first try (stops at once)" gone
expect_has   "session gone -> skip line names it"          "verdict: gone" "$LOG_OUT"
expect_lacks "session gone -> skip line names no deadline" "wait deadline" "$LOG_OUT"
run_case "$BUSY" "PANE_DEAD"
expect_calls "busy, then the pane dies (stops on the next try)" try s9 dead
run_case "$TRUST_CURSOR_ON_YES" "PANE_DEAD"
expect_calls "dialog answered, then the pane dies (no /rename)" try $ENTER s9 dead

# (c) never ready -> skipped with one log line, nothing typed, bounded. The
# failures log is shared (earlier lines of the same launch live there): the
# skip line is appended, never truncating it.
SEED='earlier launch line (SEEDLINE)'
LOG_SEED="$SEED" TRIES=3 run_case "$BUSY"
expect_eq    "never ready -> skipped"                      skipped         "$GOT"
expect_calls "never ready, bounded to TRIES"               3x try s9 /
expect_eq    "never ready -> exactly one log line"         1               "$(printf '%s\n' "$LOG_OUT" | grep -c 'RENAMEREADY1010')"
expect_eq    "never ready -> earlier log line kept, skip line appended after it" "$SEED|RENAMEREADY1010|2" \
  "$(printf '%s\n' "$LOG_OUT" | sed -n 1p)|$(printf '%s\n' "$LOG_OUT" | sed -n 2p | grep -o RENAMEREADY1010)|$(printf '%s\n' "$LOG_OUT" | grep -c .)"
expect_has   "never ready -> log names the input state"    "input: busy"   "$LOG_OUT"
expect_lacks "never ready -> skip line names no deadline (tries ran out)" "wait deadline" "$LOG_OUT"

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
  expect_calls "$label (no keys)"                          3x try s9 /
  expect_has   "$label -> skip line names input: $state"   "verdict: wait, input: $state" "$LOG_OUT"
done

# the script's own limits (no override): 10 tries, 2 s apart
TRIES=default run_case "$BUSY"
expect_eq    "default limits -> skipped"                   skipped         "$GOT"
expect_calls "default limits, 10 tries x 2 s"              10x try s2 /

# busy for a while, then ready -> sent once
run_case "$BUSY" "$BUSY" "$READY"
expect_calls "busy then ready (one /rename)"               try s9 try s9 try $RENAME

# probe cannot measure (no pane-state module): pre-fix banner signal is kept
PANE_JS=/nonexistent/pane-state.js run_case "$BANNER_ONLY"
expect_eq    "unverifiable + banner -> sent"               sent            "$GOT"
expect_calls "unverifiable + banner"                       try $RENAME
PANE_JS=/nonexistent/pane-state.js run_case "$BUSY"
expect_eq    "unverifiable, no banner -> skipped"          skipped         "$GOT"
expect_calls "unverifiable, no banner (no keys)"           4x try s9 /
PANE_JS=/nonexistent/pane-state.js run_case "$TRUST_CURSOR_ON_YES
$BANNER"
expect_calls "unverifiable + banner + dialog (answered, no /rename)" 4x try $ENTER s9 /

# --- per-call probe bound (probe_pane_input_state_bounded) ---------------------
# A probe stub wrapping the normal one: HANG_PROBE in the frame makes it spin
# forever (and it ignores SIGTERM, so only a hard kill ends it), SLOW_PROBE makes
# it answer after 1.2 s. Its path is unique, so a surviving node process is
# found by its argv.
HANG_JS="$TMPD/probe-hang-stub.js"
cat > "$HANG_JS" <<JS
const base = require('$STUB_JS')
process.on('SIGTERM', () => {})
module.exports = Object.assign({}, base, {
  stripAllAnsi: (s) => {
    if (s.includes('HANG_PROBE')) for (;;) {}
    if (s.includes('SLOW_PROBE')) { const t = Date.now(); while (Date.now() - t < 1200) {} }
    return base.stripAllAnsi(s)
  },
})
JS
# survivors: node processes still running the hang stub (waits up to 1 s for
# the killed ones to leave the process table)
survivors() {
  local i=0 out
  while [ "$i" -lt 10 ]; do
    out="$(/usr/bin/pgrep -f "$HANG_JS" 2>/dev/null || true)"
    [ -z "$out" ] && break
    /bin/sleep 0.1; i=$((i + 1))
  done
  printf '%s' "$out" | grep -c . || true
}
# expect_within <label> <min ms> <max ms>: ELAPSED_MS of the last case.
expect_within() {
  if [ "$ELAPSED_MS" -ge "$2" ] && [ "$ELAPSED_MS" -le "$3" ]; then pass "$1 (${ELAPSED_MS} ms)"
  else fail "$1" "$2..$3 ms" "${ELAPSED_MS} ms"; fi
}
# no_keys <label>: not a single send-keys in the call log (used where the
# number of tries depends on the wall clock, so the exact transcript cannot be
# pinned).
no_keys() { expect_eq "$1 -> no keys at all" 0 "$(printf '%s\n' "$CALLS_OUT" | grep -c 'send-keys' || true)"; }
# bounds_ok <label>: every probe call got min(per-call max, time left), read
# from $BOUNDS, and there was at least one call.
bounds_ok() {
  expect_eq "$1 -> each probe bound is min(per-call max, time left)" ok \
    "$(awk 'NF < 3 {bad = bad " [" $0 "]"; next}
            {want = ($3 < $2) ? $3 : $2; n++; if ($1 != want) bad = bad " [" $0 "]"}
            END {print (n > 0 && bad == "") ? "ok" : "calls=" n bad}' "$TMPD/bounds")"
}
# bounds_col <n>: column n of $BOUNDS, space-separated.
bounds_col() { awk -v c="$1" '{printf "%s%s", (NR > 1 ? " " : ""), $c}' "$TMPD/bounds"; }
# The limits themselves, read straight from rename_wait_limits: the defaults,
# the deadline formula TRIES x (SLEEP rounded up + 1), base 10 for leading
# zeros, and the malformed-value fallbacks.
# limits_of <tries> <sleep> <probe timeout>: "tries sleep unit pb_max deadline"
# ("-" = leave that variable unset).
limits_of() {
  env -u CHANNELS_RENAME_READY_TRIES -u CHANNELS_RENAME_READY_SLEEP -u CHANNELS_RENAME_PROBE_TIMEOUT \
  bash -c '. "$1"
    [ "$2" = - ] || export CHANNELS_RENAME_READY_TRIES="$2"
    [ "$3" = - ] || export CHANNELS_RENAME_READY_SLEEP="$3"
    [ "$4" = - ] || export CHANNELS_RENAME_PROBE_TIMEOUT="$4"
    rename_wait_limits; echo "$_rr_tries $_rr_sleep $_rr_unit $_rr_pb_max $_rr_deadline"' \
    _ "$LIB" "$1" "$2" "$3" 2>&1
}
for c in "defaults (30 s deadline)|- - -|10 2 2 2 30" \
         "TRIES=08 is decimal 8|08 - -|8 2 2 2 24" \
         "TRIES=010 is decimal 10|010 - -|10 2 2 2 30" \
         "TRIES=abc falls back to 10|abc - -|10 2 2 2 30" \
         "SLEEP=1.5 rounds up to 2 in the deadline|- 1.5 -|10 1.5 2 2 30" \
         "SLEEP=1.5 TRIES=2 -> deadline 6|2 1.5 -|2 1.5 2 2 6" \
         "SLEEP=08 is decimal 8|1 08 -|1 08 8 2 9" \
         "SLEEP=0.1m is malformed -> 2|3 0.1m -|3 2 2 2 9" \
         "SLEEP=1e1 is malformed -> 2|3 1e1 -|3 2 2 2 9" \
         "SLEEP=' 2' is malformed -> 2|3 ' 2' -|3 2 2 2 9" \
         "SLEEP=0 -> deadline TRIES x 1|4 0 -|4 0 0 2 4" \
         "SLEEP=.5 is malformed -> 2|3 .5 -|3 2 2 2 9" \
         "SLEEP=5. is malformed -> 2|3 5. -|3 2 2 2 9" \
         "SLEEP=1.2.3 is malformed -> 2|3 1.2.3 -|3 2 2 2 9" \
         "SLEEP=2.0 is not rounded up|3 2.0 -|3 2.0 2 2 9" \
         "SLEEP=1.05 rounds up to 2|3 1.05 -|3 1.05 2 2 9" \
         "PROBE_TIMEOUT=0 is malformed -> 2|- - 0|10 2 2 2 30" \
         "PROBE_TIMEOUT=08 is decimal 8|- - 08|10 2 2 8 30" \
         "PROBE_TIMEOUT=abc falls back to 2|- - abc|10 2 2 2 30"; do
  label="${c%%|*}"; rest="${c#*|}"; args="${rest%|*}"; want="${rest##*|}"
  eval "set -- $args"
  expect_eq "limits: $label" "$want" "$(limits_of "$1" "$2" "$3")"
done

# Wall-clock cases. The shell clock has whole-second resolution, so the wait
# may end up to 1 s after the deadline; the upper limits allow that plus 1 s
# for node start-ups. The fake sleep returns at once, so these cases spend
# their time in the probes.

# an ordinary not-ready wait keeps every try and never meets the deadline:
# real 0.1 s sleeps, fast probe, TRIES=3 -> 3 tries, deadline 3 x (1 + 1) =
# 6 s untouched (each try may take up to about 1.9 s before it would bite)
ALIGN=1 REAL_SLEEP=1 TRIES=3 SLEEP=0.1 GUARD=15 run_case "$BUSY"
expect_calls "real sleeps, fast probe: all 3 tries"        3x try s0.1 /
expect_lacks "real sleeps, fast probe -> skip line names no deadline" "wait deadline" "$LOG_OUT"

# all-hang, TRIES=3, SLEEP=0 -> deadline 3 s. Per-call bound 2 s alone would
# allow 3 x 2 = 6 s; the deadline cuts the later probe(s) mid-try. Skipped, no
# key, the skip line names the timeout and the deadline, no surviving probe.
TIMED=1 PANE_JS="$HANG_JS" PROBE_TIMEOUT=2 TRIES=3 SLEEP=0 GUARD=15 run_case "HANG_PROBE
$BUSY"
expect_eq    "hung probe, deadline 3 s -> skipped"         skipped         "$GOT"
no_keys      "hung probe, deadline 3 s"
expect_has   "hung probe, deadline 3 s -> skip line names the timeout" "verdict: wait, input: timeout" "$LOG_OUT"
expect_has   "hung probe, deadline 3 s -> skip line names the deadline" "wait deadline 3 s reached" "$LOG_OUT"
expect_eq    "hung probe, deadline 3 s -> exactly one log line" 1          "$(printf '%s\n' "$LOG_OUT" | grep -c 'RENAMEREADY1010')"
expect_within "hung probe, deadline 3 s -> ends within the deadline (+ slack)" 2000 5000
expect_eq    "hung probe, deadline 3 s -> no surviving probe process" 0    "$(survivors)"

# the per-call bound far above the deadline: the probe gets only the time
# left (3 s, or 2 s when the clock ticked during the try's tmux calls), never
# its own 10 s; checked against the wait's own reading of the time left.
ALIGN=1 PANE_JS="$HANG_JS" PROBE_TIMEOUT=10 TRIES=3 SLEEP=0 GUARD=20 run_case "HANG_PROBE
$BUSY"
expect_eq    "per-call 10 s, deadline 3 s -> skipped"      skipped         "$GOT"
expect_calls "per-call 10 s, deadline 3 s (one try)"       try
expect_has   "per-call 10 s, deadline 3 s -> skip line names the deadline" "wait deadline 3 s reached" "$LOG_OUT"
bounds_ok    "per-call 10 s, deadline 3 s"
expect_eq    "per-call 10 s, deadline 3 s -> one probe, cut below its 10 s" "yes" \
  "$(awk 'END {print (NR == 1 && $1 < 10 && $1 >= 1) ? "yes" : "no: " NR " calls, last [" $0 "]"}' "$TMPD/bounds")"
expect_eq    "per-call 10 s, deadline 3 s -> no surviving probe process" 0 "$(survivors)"

# a sleep longer than the time left is cut to exactly the time left: TRIES=1,
# SLEEP=5, per-call 3 s -> deadline 6 s; after the 3 s hung probe 1-3 s are
# left (fewer on a slow runner), so the one sleep must equal the wait's own
# time left, below 5 (a cut one second long or no cut fails).
PANE_JS="$HANG_JS" PROBE_TIMEOUT=3 TRIES=1 SLEEP=5 GUARD=15 run_case "HANG_PROBE
$BUSY"
expect_eq    "sleep cut to exactly the time left" "yes" \
  "$(awk 'END {print (NR == 1 && $3 > $2 && $1 == $2 && $1 >= 1) ? "yes" : "no: " NR " sleeps, last [" $0 "]"}' "$TMPD/sleeps")"
expect_calls "sleep cut, one try and one sleep"            try "s$(awk '{print $1}' "$TMPD/sleeps")"
expect_eq    "sleep cut -> no surviving probe process"     0               "$(survivors)"

# a hung probe is killed after exactly its bound: per-call 1 s, deadline far
# away (TRIES=2, SLEEP=9). Each probe's own wall time (from the wrapper, so
# the tmux calls around it do not count; it does include the -e capture the
# probe reads, about one fake tmux call) must be 1 s and well under 2 s.
PROBE_MS=1 PANE_JS="$HANG_JS" PROBE_TIMEOUT=1 TRIES=2 GUARD=15 run_case "HANG_PROBE
$BUSY"
bounds_ok    "hung probe, bound 1 s"
expect_eq    "hung probe, bound 1 s -> each probe killed after 1000..1700 ms" "yes" \
  "$(awk '{n++; if ($4 < 1000 || $4 > 1700) bad = bad " " $4} END {print (n == 2 && bad == "") ? "yes" : "no: " n " calls," bad}' "$TMPD/bounds")"
expect_eq    "hung probe, bound 1 s -> no surviving probe process" 0     "$(survivors)"

# the last try ends past the deadline: the try limit ended the wait, so the
# skip line names no deadline. TRIES=1, SLEEP=1, per-call 2 s -> deadline 2 s;
# the one hung probe ends at 2 s.
ALIGN=1 PANE_JS="$HANG_JS" PROBE_TIMEOUT=2 TRIES=1 SLEEP=1 GUARD=15 run_case "HANG_PROBE
$BUSY"
expect_calls "last try ends past the deadline (one try)"   try
expect_has   "last try past the deadline -> skip line names the timeout" "input: timeout" "$LOG_OUT"
expect_lacks "last try past the deadline -> skip line names no deadline" "wait deadline" "$LOG_OUT"

# the deadline found at the top of a try, after a real sleep used up the time
# left: TRIES=2, SLEEP=2, per-call 4 s -> deadline 6 s. The 4 s probe leaves
# 1-2 s, the (possibly cut) real sleep uses them, and the next try stops before
# any tmux call: the transcript ends with that one sleep.
ALIGN=1 REAL_SLEEP=1 PANE_JS="$HANG_JS" PROBE_TIMEOUT=4 TRIES=2 SLEEP=2 GUARD=20 run_case "HANG_PROBE
$BUSY"
expect_calls "deadline at the top of the next try"         try "s$(awk 'NR == 1 {print $1}' "$TMPD/sleeps")"
expect_eq    "deadline at the top of the next try -> one sleep, cut to the time left if shorter" "yes" \
  "$(awk 'END {want = ($3 > $2) ? $2 : 2; print (NR == 1 && $1 == want) ? "yes" : "no: " NR " sleeps, last [" $0 "]"}' "$TMPD/sleeps")"
expect_has   "deadline at the top of the next try -> skip line names it" "input: timeout; wait deadline 6 s reached" "$LOG_OUT"

# the line names the deadline, not the elapsed time: a dialog answered after a
# probe cut to the deadline (its real sleep 1) ends the try 1 s past it.
# TRIES=2, SLEEP=0, per-call 10 s -> deadline 2 s; ends at 3 s.
ALIGN=1 REAL_SLEEP=1 PANE_JS="$HANG_JS" PROBE_TIMEOUT=10 TRIES=2 SLEEP=0 GUARD=15 run_case "$TRUST_CURSOR_ON_NO
HANG_PROBE"
expect_calls "dialog answered after a cut probe (one try)" try $DOWN_ENTER
expect_has   "dialog after a cut probe -> skip line names the 2 s deadline" "verdict: dialog, input: timeout; wait deadline 2 s reached" "$LOG_OUT"

# a timeout is not "unverifiable": the banner fallback must not make it ready
PANE_JS="$HANG_JS" PROBE_TIMEOUT=1 TRIES=2 SLEEP=1 GUARD=15 run_case "HANG_PROBE
$BANNER_ONLY"
expect_eq    "hung probe + banner -> skipped (no fallback)" skipped        "$GOT"
no_keys      "hung probe + banner"
expect_has   "hung probe + banner -> skip line names the timeout" "input: timeout" "$LOG_OUT"
expect_eq    "hung probe + banner -> no surviving probe process" 0         "$(survivors)"

# one hung try, then a ready pane, inside the deadline (8 s) -> exactly one
# /rename (after the 1 s hang several seconds are left, so the full 1 s sleep
# runs)
PANE_JS="$HANG_JS" PROBE_TIMEOUT=1 TRIES=4 SLEEP=1 GUARD=15 run_case "HANG_PROBE
$BANNER" "$READY"
expect_eq    "hung once, then ready -> sent"               sent            "$GOT"
expect_calls "hung once, then ready (one /rename)"         try s1 try $RENAME
expect_eq    "hung once, then ready -> no surviving probe process" 0       "$(survivors)"

# the default per-call bound (2 s, inside a 10 s deadline), and a malformed
# override falling back to it: one timed-out try, then ready
for pt in "" abc; do
  PANE_JS="$HANG_JS" PROBE_TIMEOUT="$pt" TRIES=5 SLEEP=1 GUARD=15 run_case "HANG_PROBE
$BANNER" "$READY"
  expect_calls "per-call bound '${pt:-default}', hung once then ready (one /rename)" try s1 try $RENAME
  expect_eq    "per-call bound '${pt:-default}' -> 2 s for each probe" "2 2" "$(bounds_col 1)"
  expect_eq    "per-call bound '${pt:-default}' -> no surviving probe process" 0 "$(survivors)"
  expect_eq    "per-call bound '${pt:-default}' -> probe scratch dir removed" "" "$(ls -A "$TMPD/probe-tmp")"
done

# slow but inside the bound -> its answer counts
TIMED=1 PANE_JS="$HANG_JS" PROBE_TIMEOUT=2 GUARD=15 run_case "SLOW_PROBE
$READY"
expect_eq    "slow probe in bound -> sent"                 sent            "$GOT"
expect_calls "slow probe in bound (one /rename)"           try $RENAME
expect_within "slow probe in bound -> waited for the answer" 1200 4000

# positive control with the bound set: a normal probe is unaffected, answers
# without waiting out the bound, and its watchdog (an uncommon 7 s sleep here,
# inside a 9 s deadline) does not outlive the call; the probe's scratch dir is
# removed
TIMED=1 PROBE_TIMEOUT=7 TRIES=9 SLEEP=1 run_case "$READY"
expect_eq    "normal probe, bound set -> sent"             sent            "$GOT"
expect_calls "normal probe, bound set (one /rename)"       try $RENAME
expect_within "normal probe, bound set -> does not wait out the bound" 0 3000
expect_eq    "normal probe -> no surviving watchdog sleep" 0 \
  "$( (/usr/bin/pgrep -f '^/bin/sleep 7$' 2>/dev/null || true) | grep -c . || true)"
expect_eq    "normal probe -> probe scratch dir removed"   "" "$(ls -A "$TMPD/probe-tmp")"

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
