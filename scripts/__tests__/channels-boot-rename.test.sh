#!/bin/bash
# Contract tests for the main session's boot /rename (#1954, part B;
# scripts/lib/main-rename.sh).
#
# Origin (issue #1954, reported on Linux/systemd): after every host reboot the
# one-shot `send-keys "/rename <bot>" Enter` in channels.sh lost its Enter, the
# command stayed in the input box, and scheduled tasks were deferred for about
# an hour. channels.sh now types the text, sends Enter on its own, and repeats
# only the Enter (bounded) while the box still holds exactly the command.
#
# Only the LIBRARY runs here, against a fake tmux that logs every call and
# replays scripted pane captures. channels.sh itself is never executed (it
# starts the live main session); its wiring is checked by reading the file.
# Run: bash scripts/__tests__/channels-boot-rename.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }
eq() { if [ "$3" = "$2" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LIB="${MAIN_RENAME_LIB:-$INSTALL_DIR/scripts/lib/main-rename.sh}"
CHANNELS="$INSTALL_DIR/scripts/channels.sh"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

# shellcheck source=../lib/main-rename.sh
. "$LIB"

# The fake tmux. Every call is logged one per line ($FAKE_LOG). capture-pane
# prints frame-<n> for its n-th call (the last frame repeats once they run
# out); FAKE_CAPTURE_FAIL=1 makes it fail, FAKE_SEND_FAIL=1 fails send-keys.
cat > "$TMPD/tmux" <<'EOF'
#!/bin/bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  capture-pane)
    [ "${FAKE_CAPTURE_FAIL:-0}" = "1" ] && exit 1
    n=$(( $(cat "$FAKE_DIR/count" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_DIR/count"
    f="$FAKE_DIR/frame-$n"
    [ -f "$f" ] || f="$(ls "$FAKE_DIR"/frame-* | sort -t- -k2 -n | tail -1)"
    cat "$f"
    ;;
  send-keys)
    [ "${FAKE_SEND_FAIL:-0}" = "1" ] && exit 1
    ;;
esac
exit 0
EOF
chmod +x "$TMPD/tmux"

# The pane measured in the #1948 report: the command parked in the box, with
# the session-title banner above and the footer below.
PARKED=$'earlier output\n\n──────────── Marveen ─\n❯ /rename Marveen\n────────────────────\n  Sonnet 5 | ctx 11% | 7d 5%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)'
# Submitted: the command is echoed in the transcript, the box is empty.
DONE=$'❯ /rename Marveen\n  ⎿  Session renamed to: Marveen\n\n────────────────────\n❯ \n────────────────────\n  Sonnet 5 | ctx 11% | 7d 5%'
# Someone else's text in the box: never the bot's own command.
OTHER=$'────────────────────\n❯ /rename Marveen please not yet\n────────────────────\n  footer'

# run <frames...>: a fresh fake, the given captures, one main_rename_send.
run() {
  export FAKE_DIR="$TMPD/case$RANDOM$RANDOM"; mkdir -p "$FAKE_DIR"
  export FAKE_LOG="$FAKE_DIR/log"; : > "$FAKE_LOG"
  local i=0 f
  for f in "$@"; do i=$((i + 1)); printf '%s\n' "$f" > "$FAKE_DIR/frame-$i"; done
  MAIN_RENAME_RETRY_S=0 MAIN_RENAME_TYPE_S=0 main_rename_send "$TMPD/tmux" "=main-channels:" "Marveen" 2> "$FAKE_DIR/err"
  RC=$?
}
enters()  { grep -c '^send-keys -t =main-channels: Enter$' "$FAKE_LOG"; }
texts()   { grep -c '^send-keys -t =main-channels: -l /rename Marveen$' "$FAKE_LOG"; }
nonenter(){ grep '^send-keys' "$FAKE_LOG" | grep -v ' Enter$' | grep -vc ' -l /rename Marveen$'; }

echo "the box parser"
echo "=============="
eq "parked pane: the box holds the command"       "/rename Marveen" "$(main_rename_box_text "$PARKED")"
eq "submitted pane: the echoed history line is not the box" "" "$(main_rename_box_text "$DONE")"
eq "a bordered box is read too" "/rename Árvíztűrő" "$(main_rename_box_text $'│ ❯ /rename Árvíztűrő  │')"
eq "...also under a C locale (no multi-byte damage)" "/rename Árvíztűrő" "$(LC_ALL=C main_rename_box_text $'│ ❯ /rename Árvíztűrő  │')"

echo ""
echo "main_rename_send"
echo "================"
run "$DONE"
eq "the Enter lands: exit 0"                          "0" "$RC"
eq "...text typed once, literally (-l)"               "1" "$(texts)"
eq "...and exactly one Enter"                         "1" "$(enters)"
eq "...and the text comes before the Enter"           "send-keys -t =main-channels: -l /rename Marveen" "$(head -1 "$FAKE_LOG")"

run "$PARKED" "$DONE"
eq "the first Enter is lost: exit 0 after a retry"   "0" "$RC"
eq "...two Enters in all"                             "2" "$(enters)"
eq "...the text is NOT typed again"                   "1" "$(texts)"
case "$(cat "$FAKE_DIR/err")" in *"Enter again (1/3)"*) pass "...and the retry is logged" ;; *) fail "...and the retry is logged" "Enter again (1/3)" "$(cat "$FAKE_DIR/err")" ;; esac

run "$PARKED"
eq "parked for good: exit 1, bounded"                 "1" "$RC"
eq "...1 Enter + MAIN_RENAME_MAX_ENTERS (3) retries"  "4" "$(enters)"
eq "...never anything but the text and Enter (no clear)" "0" "$(nonenter)"
case "$(cat "$FAKE_DIR/err")" in *"left as is"*) pass "...and the give-up is logged" ;; *) fail "...and the give-up is logged" "left as is" "$(cat "$FAKE_DIR/err")" ;; esac

run "$OTHER"
eq "someone else's text in the box: no extra Enter"  "1" "$(enters)"
eq "...exit 0"                                        "0" "$RC"

FAKE_CAPTURE_FAIL=1 run "$PARKED"
eq "an unreadable pane: no extra Enter, exit 0"       "1" "$(enters)"

FAKE_SEND_FAIL=1 run "$DONE"
eq "the first send fails: exit 2"                     "2" "$RC"

echo ""
echo "channels.sh wiring (read, never run)"
echo "===================================="
ready="$(grep -n 'Listening for messages from' "$CHANNELS" | tail -1 | cut -d: -f1)"
src="$(grep -n '^if \. "\$INSTALL_DIR/scripts/lib/main-rename.sh"; then$' "$CHANNELS" | cut -d: -f1)"
call="$(grep -n '^  main_rename_send "\$TMUX" "=\$SESSION:" "\$_bot_name" || true$' "$CHANNELS" | cut -d: -f1)"
keep="$(grep -n 'touch "\$INSTALL_DIR/store/.channel-keepalive"' "$CHANNELS" | head -1 | cut -d: -f1)"
oneshot="$(grep -c '"/rename ${_bot_name}" Enter' "$CHANNELS")"
if [ -n "$src" ] && [ -n "$call" ] && [ -n "$ready" ] && [ -n "$keep" ] && [ "$ready" -lt "$src" ] && [ "$src" -lt "$call" ] && [ "$call" -lt "$keep" ]; then
  pass "channels.sh sources the library and calls main_rename_send after the ready banner"
else
  fail "channels.sh wiring" "ready < source < call < keepalive" "ready=$ready source=$src call=$call keepalive=$keep"
fi
eq "the one-shot send is left only as the fallback"  "1" "$oneshot"
fallback="$(sed -n "${call},\$p" "$CHANNELS" | grep -n '"/rename ${_bot_name}" Enter' | head -1 | cut -d: -f1)"
if [ -n "$fallback" ] && [ "$fallback" -le 6 ]; then pass "...inside the else branch right after the call"; else fail "...inside the else branch" "within 6 lines after the call" "$fallback"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
