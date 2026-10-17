# shellcheck shell=bash
# The main session's identity /rename at boot, sent so that a lost Enter does
# not leave it parked (#1954). Sourced by scripts/channels.sh.
#
# REPORTED (issue #1954, Linux/systemd, Discord): after every host reboot the
# one-shot `send-keys "/rename <bot>" Enter` lost its Enter, `/rename <bot>`
# stayed in the input box, and the dashboard's stuck-input watcher held it (it
# cannot tell this line from a human draft), so scheduled tasks were deferred
# for 59 and 84 minutes. Why the Enter is lost was not measured (TUI timing
# right after the ready banner, or the slash-command menu). Not seen on our
# macOS host after its 2026-10-15 reboot, one sample.
#
# What this does instead, the same idea as sendPromptToSession's post-send
# check: type the text literally, send Enter on its own, then look at the input
# box. While it still holds exactly `/rename <name>`, press Enter again, at most
# MAIN_RENAME_MAX_ENTERS times. Only Enter is ever re-sent: never the text
# again, and never a clear, so nothing typed by anyone else can be lost.

# The text of the input box: the last prompt line (`❯ ...`) of a pane capture,
# without the prompt marker. The box sits below the transcript, so the last
# such line is the box, not an echoed history line. Empty when there is none.
main_rename_box_text() {
  # Alternations, not bracket sets: under a C locale `[│ ]` matches single
  # bytes, and a trailing strip could eat part of a multi-byte character.
  printf '%s\n' "$1" | grep -E '^( |│)*❯' | tail -n 1 \
    | sed -E 's/^( |│)*❯ ?//; s/([[:space:]]|│)+$//'
}

# main_rename_send <tmux> <target> <name>
# Exit 0 when the box no longer holds the command (or cannot be read), 1 when
# it is still parked after every retry (logged), 2 when the first send failed.
main_rename_send() {
  local tmux="$1" target="$2" name="$3"
  local max="${MAIN_RENAME_MAX_ENTERS:-3}" wait_s="${MAIN_RENAME_RETRY_S:-1}"
  local cmd="/rename ${name}" i=0 pane box
  "$tmux" send-keys -t "$target" -l "$cmd" || return 2
  sleep "${MAIN_RENAME_TYPE_S:-0.3}"
  "$tmux" send-keys -t "$target" Enter || return 2
  while :; do
    sleep "$wait_s"
    pane="$("$tmux" capture-pane -p -t "$target" 2>/dev/null)" || return 0
    box="$(main_rename_box_text "$pane")"
    [ "$box" = "$cmd" ] || return 0
    if [ "$i" -ge "$max" ]; then
      echo "$(date '+%F %T') channels.sh: boot /rename still in the input box after $i extra Enter(s) -- left as is" >&2
      return 1
    fi
    i=$((i + 1))
    echo "$(date '+%F %T') channels.sh: boot /rename still in the input box -- Enter again ($i/$max)" >&2
    "$tmux" send-keys -t "$target" Enter || return 1
  done
}
