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
# The prompt is drawn and the box is empty: ready to type.
READY=$'──────────── Marveen ─\n────────────────────\n❯ \n────────────────────\n  footer'
# Booting: the ready banner is out, the input prompt is not drawn yet
# (the 2026-10-23 boot: text sent here parked for hours).
BOOTING=$'Listening for messages from Telegram\n  loading...'
# A session started with history: an earlier prompt is echoed, no box yet.
HISTORY_BOOTING=$'❯ /rename Marveen\n  ⎿  Session renamed to: Marveen\nListening for messages from Telegram'
# Someone else's text in the box: never the bot's own command.
OTHER=$'────────────────────\n❯ /rename Marveen please not yet\n────────────────────\n  footer'

# run <frames...>: a fresh fake, the given captures, one main_rename_send.
run() {
  export FAKE_DIR="$TMPD/case$RANDOM$RANDOM"; mkdir -p "$FAKE_DIR"
  export FAKE_LOG="$FAKE_DIR/log"; : > "$FAKE_LOG"
  local i=0 f
  for f in "$@"; do i=$((i + 1)); printf '%s\n' "$f" > "$FAKE_DIR/frame-$i"; done
  MAIN_RENAME_RETRY_S=0 MAIN_RENAME_TYPE_S=0 MAIN_RENAME_POLL_S=0 main_rename_send "$TMPD/tmux" "=main-channels:" "Marveen" 2> "$FAKE_DIR/err"
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
eq "...and the text comes before the Enter"           "send-keys -t =main-channels: -l /rename Marveen" "$(grep '^send-keys' "$FAKE_LOG" | head -1)"

run "$READY" "$PARKED" "$DONE"
eq "the first Enter is lost: exit 0 after a retry"   "0" "$RC"
eq "...two Enters in all"                             "2" "$(enters)"
eq "...the text is NOT typed again"                   "1" "$(texts)"
case "$(cat "$FAKE_DIR/err")" in *"Enter again (1/3)"*) pass "...and the retry is logged" ;; *) fail "...and the retry is logged" "Enter again (1/3)" "$(cat "$FAKE_DIR/err")" ;; esac

run "$READY" "$PARKED"
eq "parked for good: exit 1, bounded"                 "1" "$RC"
eq "...1 Enter + MAIN_RENAME_MAX_ENTERS (3) retries"  "4" "$(enters)"
eq "...never anything but the text and Enter (no clear)" "0" "$(nonenter)"
case "$(cat "$FAKE_DIR/err")" in *"left as is"*) pass "...and the give-up is logged" ;; *) fail "...and the give-up is logged" "left as is" "$(cat "$FAKE_DIR/err")" ;; esac

run "$READY" "$OTHER"
eq "someone else's text in the box: no extra Enter"  "1" "$(enters)"
eq "...exit 0"                                        "0" "$RC"

FAKE_CAPTURE_FAIL=1 run "$PARKED"
eq "an unreadable pane is an unknown screen: nothing is typed (Dani 63870)" "0" "$(grep -c '^send-keys' "$FAKE_LOG")"
eq "...exit 3"                                        "3" "$RC"
case "$(cat "$FAKE_DIR/err")" in *"the pane cannot be read, NOT typing"*) pass "...and the skip is logged" ;; *) fail "...and the skip is logged" "the pane cannot be read, NOT typing" "$(cat "$FAKE_DIR/err")" ;; esac

FAKE_SEND_FAIL=1 run "$DONE"
eq "the first send fails: exit 2"                     "2" "$RC"

echo ""
echo "waiting for the input prompt (2026-10-23 boot)"
echo "=============================================="
run "$BOOTING" "$BOOTING" "$READY" "$DONE"
first_send="$(grep -n '^send-keys' "$FAKE_LOG" | head -1 | cut -d: -f1)"
eq "no prompt yet: nothing is typed before it is drawn (3 captures first)" "4" "$first_send"
eq "...then the text is typed once"                   "1" "$(texts)"
eq "...one Enter, exit 0"                             "1 0" "$(enters) $RC"

run "$READY" "$BOOTING" "$PARKED" "$DONE"
eq "no prompt right after the Enter is not read as submitted: a retry follows" "2" "$(enters)"
eq "...exit 0"                                        "0" "$RC"

run "$HISTORY_BOOTING" "$READY" "$DONE"
first_send="$(grep -n '^send-keys' "$FAKE_LOG" | head -1 | cut -d: -f1)"
eq "an echoed earlier prompt is not the input box: waits for the box" "3" "$first_send"

run "$READY" "$BOOTING" "$BOOTING" "$BOOTING" "$PARKED" "$PARKED" "$DONE"
eq "no-prompt captures do not use up the Enter retries" "3 0" "$(enters) $RC"

eq "prompt-drawn: box between rules"                  "0" "$(main_rename_prompt_drawn "$READY"; echo $?)"
eq "prompt-drawn: bordered box"                       "0" "$(main_rename_prompt_drawn $'│ ❯ hi  │\n╰────╯'; echo $?)"
eq "prompt-drawn: history echo only"                  "1" "$(main_rename_prompt_drawn "$HISTORY_BOOTING"; echo $?)"
eq "prompt-drawn: a numbered dialog cursor is not the box" "1" "$(main_rename_prompt_drawn $'│ ❯ 2. No, exit │\n╰────╯'; echo $?)"

ECHO_OTHER=$'❯ hello\n  ⎿  hi\nworking...'
run "$READY" "$ECHO_OTHER" "$PARKED" "$DONE"
eq "after the Enter, an echoed other prompt with no box is not read as submitted" "2 0" "$(enters) $RC"

MAIN_RENAME_READY_TRIES=2 run "$BOOTING"
eq "the prompt never shows: nothing is typed (#2389)"  "0" "$(grep -c '^send-keys' "$FAKE_LOG")"
eq "...exit 3 (not typed)"                            "3" "$RC"
case "$(cat "$FAKE_DIR/err")" in *"no input prompt after 2 capture(s), NOT typing"*) pass "...and the skip is logged" ;; *) fail "...and the skip is logged" "no input prompt after 2 capture(s), NOT typing" "$(cat "$FAKE_DIR/err")" ;; esac

echo ""
echo "a startup dialog on screen (#2389, 2026-10-31 crash loop)"
echo "========================================================="
# The 2.1.252+ panels: "No, exit" is the FIRST, highlighted row, so an Enter quits.
TRUST=$'╭──────────────────────────────────────╮\n│ Accessing workspace:                 │\n│ /opt/marveen                         │\n│ Quick safety check: Is this a project│\n│ you created or one you trust?        │\n│ ❯ No, exit                           │\n│   Yes, I trust this folder           │\n│ Enter to confirm · Esc to cancel     │\n╰──────────────────────────────────────╯'
TRUST_OLD=$'Do you trust the files in this folder?\n\n❯ No, exit\n  Yes, proceed\n\nEnter to confirm · Esc to exit'
BYPASS=$'Bypass Permissions mode\n\n❯ No, exit\n  Yes, I accept\n\nEnter to confirm · Esc to exit'
# The cursor on the LAST option with the border right below reads like a box to
# main_rename_prompt_drawn alone (cursor line + rule): the dialog check must win.
TRUST_BOXLIKE=$'│ Accessing workspace: /opt/marveen │\n│   No, exit                        │\n│ ❯ Yes, I trust this folder        │\n╰───────────────────────────────────╯'

MAIN_RENAME_READY_TRIES=3 run "$TRUST"
eq "trust dialog for the whole wait: 0 send-keys"     "0" "$(grep -c '^send-keys' "$FAKE_LOG")"
eq "...exit 3"                                        "3" "$RC"
case "$(cat "$FAKE_DIR/err")" in *"startup dialog"*"NOT typing"*) pass "...and the dialog is named in the log" ;; *) fail "...and the dialog is named in the log" "startup dialog ... NOT typing" "$(cat "$FAKE_DIR/err")" ;; esac

MAIN_RENAME_READY_TRIES=3 run "$TRUST_OLD"
eq "the older trust wording: 0 send-keys"             "0" "$(grep -c '^send-keys' "$FAKE_LOG")"

MAIN_RENAME_READY_TRIES=3 run "$BYPASS"
eq "bypass-permissions dialog: 0 send-keys"           "0" "$(grep -c '^send-keys' "$FAKE_LOG")"
eq "...exit 3"                                        "3" "$RC"

eq "prompt-drawn alone is fooled by a box-like dialog (why the dialog check exists)" "0" "$(main_rename_prompt_drawn "$TRUST_BOXLIKE"; echo $?)"
MAIN_RENAME_READY_TRIES=3 run "$TRUST_BOXLIKE"
eq "...but the wait never reads it as ready: 0 send-keys" "0" "$(grep -c '^send-keys' "$FAKE_LOG")"
BYPASS_BOXLIKE=$'│ Bypass Permissions mode           │\n│   No, exit                        │\n│ ❯ Yes, I accept                   │\n╰───────────────────────────────────╯'
eq "prompt-drawn alone is fooled by a box-like bypass panel too" "0" "$(main_rename_prompt_drawn "$BYPASS_BOXLIKE"; echo $?)"
MAIN_RENAME_READY_TRIES=3 run "$BYPASS_BOXLIKE"
eq "...and the wait does not read it as ready either: 0 send-keys" "0" "$(grep -c '^send-keys' "$FAKE_LOG")"

run "$TRUST" "$TRUST" "$READY" "$DONE"
first_send="$(grep -n '^send-keys' "$FAKE_LOG" | head -1 | cut -d: -f1)"
eq "the dialog is answered, then the box appears: typed after it (4th call)" "4" "$first_send"
eq "...once, one Enter, exit 0"                       "1 1 0" "$(texts) $(enters) $RC"

eq "dialog-visible: the input box is not a dialog"    "1" "$(main_rename_dialog_visible "$READY"; echo $?)"
eq "dialog-visible: the parked box is not a dialog"   "1" "$(main_rename_dialog_visible "$PARKED"; echo $?)"

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

# #2389: the startup guard's window. The two parsing lines are taken from
# channels.sh itself and run here, so the test follows the real code.
eq "the fixed 12-pass guard loop is gone"             "0" "$(grep -c '^for i in 1 2 3 4 5 6 7 8 9 10 11 12; do$' "$CHANNELS")"
# Dani 63870: the ready banner is matched before the welcome's blind Enter in the guard.
guard_loop="$(sed -n '/^while \[ "\$i" -lt "\$_boot_guard_s" \]; do$/,/^done$/p' "$CHANNELS")"
ready_at="$(printf '%s\n' "$guard_loop" | grep -n 'Listening for channel messages' | head -1 | cut -d: -f1)"
welcome_at="$(printf '%s\n' "$guard_loop" | grep -n '"Welcome to Claude Code"' | head -1 | cut -d: -f1)"
if [ -n "$ready_at" ] && [ -n "$welcome_at" ] && [ "$ready_at" -lt "$welcome_at" ]; then pass "the ready banner's branch comes before the welcome's blind Enter"; else fail "ready before welcome" "ready < welcome" "ready=$ready_at welcome=$welcome_at"; fi
eq "the guard loop is bounded by _boot_guard_s"       "1" "$(grep -c '^while \[ "\$i" -lt "\$_boot_guard_s" \]; do$' "$CHANNELS")"
guard_parse="$(grep -E '^_boot_guard_s="\$\{CHANNELS_BOOT_GUARD_S:-90\}"$|^case "\$_boot_guard_s" in ' "$CHANNELS")"
eq "...both parsing lines are found"                  "2" "$(printf '%s\n' "$guard_parse" | grep -c .)"
guard_for() { ( unset CHANNELS_BOOT_GUARD_S; [ "$1" = "<unset>" ] || CHANNELS_BOOT_GUARD_S="$1"; eval "$guard_parse"; printf '%s' "$_boot_guard_s" ); }
eq "CHANNELS_BOOT_GUARD_S unset: 90 s"                "90" "$(guard_for '<unset>')"
eq "CHANNELS_BOOT_GUARD_S=30: 30 s"                   "30" "$(guard_for 30)"
eq "CHANNELS_BOOT_GUARD_S=0: the default, not a skipped guard" "90" "$(guard_for 0)"
eq "CHANNELS_BOOT_GUARD_S=abc: the default"           "90" "$(guard_for abc)"
eq "CHANNELS_BOOT_GUARD_S=-5: the default"            "90" "$(guard_for -5)"
eq "CHANNELS_BOOT_GUARD_S empty: the default"         "90" "$(guard_for '')"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
