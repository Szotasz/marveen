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

# True when the capture shows the INPUT BOX: a prompt line (`❯`) directly
# followed by the box's rule line. A bare `❯ ...` line is not enough -- the
# transcript echoes earlier prompts in the same form (`❯ /rename <name>` above a
# `⎿` result), and a session started with history would otherwise read as ready
# before the box exists (review finding, 2026-10-24). A numbered menu cursor
# (`│ ❯ 2. No, exit │` in a startup dialog) is not the input box either: the
# Enter would pick that option.
main_rename_prompt_drawn() {
  printf '%s\n' "$1" | awk '
    p && /^( |│|╰|└)*─/ { found = 1; exit }
    { p = ($0 ~ /^( |│)*❯/ && $0 !~ /❯ *[0-9]+\./) }
    END { exit !found }'
}

# True when a startup confirmation dialog is on screen: the folder-trust panel
# (both wordings) or the bypass-permissions panel. Anchored on the same texts as
# the startup guard in channels.sh. On both panels the FIRST, highlighted row is
# "No, exit" (2.1.252+), so an Enter typed there quits the session (#2389).
main_rename_dialog_visible() {
  case "$1" in
    *"Do you trust the files in this folder?"*|*"Yes, I trust this folder"*) return 0 ;;
    *"Bypass Permissions mode"*"Yes, I accept"*) return 0 ;;
  esac
  return 1
}

# main_rename_wait_prompt <tmux> <target>
# Before typing, wait until the TUI has drawn its input prompt (#1954 follow-up).
# REPORTED (2026-10-23, two Linux installs at one host boot): the text was sent
# while the ready banner was printed but before the prompt existed; the 1 s
# check then saw no box, read it as "submitted", and the text appeared in the
# box afterwards, parked for 4 and 9 hours. Polls every MAIN_RENAME_POLL_S
# (default 1) up to MAIN_RENAME_READY_TRIES (default 60) captures. An
# unreadable pane is an unknown screen too (Dani 63870): exit 1, logged, nothing
# is typed.
#
# Exit 1 when the prompt never shows (#2389): the rename is then NOT typed, and
# that is logged. REPORTED (2026-10-31, Linux/Discord): a folder-trust dialog
# drawn after the startup guard's window stayed on screen for the whole wait,
# and the old "typing anyway" Enter confirmed its highlighted "No, exit" row:
# the session quit, and the restart loop repeated it 12 times in an hour. A
# skipped rename only leaves the session unnamed; an Enter onto an unknown
# screen can end the session. A dialog on screen never counts as ready, even
# when a cursor row followed by a rule looks like the input box.
main_rename_wait_prompt() {
  local tmux="$1" target="$2" n=0 tries="${MAIN_RENAME_READY_TRIES:-60}" pane="" why
  while [ "$n" -lt "$tries" ]; do
    if ! pane="$("$tmux" capture-pane -p -t "$target" 2>/dev/null)"; then
      echo "$(date '+%F %T') channels.sh: boot /rename -- the pane cannot be read, NOT typing (#2389)" >&2
      return 1
    fi
    if main_rename_prompt_drawn "$pane" && ! main_rename_dialog_visible "$pane"; then
      return 0
    fi
    n=$((n + 1))
    sleep "${MAIN_RENAME_POLL_S:-1}"
  done
  why="no input prompt"
  main_rename_dialog_visible "$pane" && why="a startup dialog (folder trust / bypass) is on screen"
  echo "$(date '+%F %T') channels.sh: boot /rename -- $why after $n capture(s), NOT typing (#2389)" >&2
  return 1
}

# main_rename_send <tmux> <target> <name>
# Exit 0 when the box no longer holds the command (or cannot be read), 1 when
# it is still parked after every retry (logged), 2 when the first send failed,
# 3 when nothing was typed because the input prompt never showed (logged).
main_rename_send() {
  local tmux="$1" target="$2" name="$3"
  local max="${MAIN_RENAME_MAX_ENTERS:-3}" wait_s="${MAIN_RENAME_RETRY_S:-1}"
  local cmd="/rename ${name}" i=0 w=0 pane box
  main_rename_wait_prompt "$tmux" "$target" || return 3
  "$tmux" send-keys -t "$target" -l "$cmd" || return 2
  sleep "${MAIN_RENAME_TYPE_S:-0.3}"
  "$tmux" send-keys -t "$target" Enter || return 2
  while :; do
    sleep "$wait_s"
    pane="$("$tmux" capture-pane -p -t "$target" 2>/dev/null)" || return 0
    box="$(main_rename_box_text "$pane")"
    # No prompt line at all is not an empty box: the TUI has not drawn it
    # yet, so "the command left the box" cannot be read from this capture.
    # Its own bound (w), so these captures never use up the Enter retries.
    # Checked before the box text: without a drawn box, the last `❯` line is a
    # transcript echo, and its text says nothing about this command.
    if ! main_rename_prompt_drawn "$pane"; then
      if [ "$w" -ge "$max" ]; then
        echo "$(date '+%F %T') channels.sh: boot /rename -- input prompt still not drawn after the Enter, box not checked" >&2
        return 1
      fi
      w=$((w + 1))
      continue
    fi
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
