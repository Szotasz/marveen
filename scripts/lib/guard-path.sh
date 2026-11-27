#!/bin/bash
# Guard-script PATH (ISSUE3201, #3201). Sourced, never executed.
#
# Why: a systemd user unit hands its script a fixed PATH that the installer wrote
# (Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin).
# On a host where node, npm and the npm-installed claude live only under Homebrew
# on Linux (/home/linuxbrew/.linuxbrew/bin), `command -v claude` came back empty,
# and channel-watchdog.sh gave up without recovering a dead channels session.
# channels.sh already sets its own PATH (#1968, #2578); the guard scripts that
# look up tmux, claude or node did not.
#
# The script is the one place that must be right whoever launched it, and an
# installed unit is not rewritten by update.sh, so the fix lives here, not only in
# the installers. The same dirs as the channels.sh boot PATH are APPENDED to the
# caller's PATH, never put in front of it: the unit's order (the native
# ~/.local/bin/claude first, NATIVECLAUDEFIRST1011) and a test stub placed first
# on PATH both stay in front. A dir already on PATH is not added twice.
#
# scripts/lib/unit-path-check.sh (the doctor) counts these dirs as on the PATH of
# the units whose scripts call guard_path_widen.

# guard_path_dirs -- the dirs guard_path_widen adds, one per line.
guard_path_dirs() {
  printf '%s\n' "$HOME/.local/bin" /opt/homebrew/bin "$HOME/.bun/bin" /home/linuxbrew/.linuxbrew/bin /usr/local/bin /usr/bin /bin
}

guard_path_widen() {
  local _gp_dir
  while IFS= read -r _gp_dir; do
    case ":${PATH:-}:" in
      *":$_gp_dir:"*) ;;
      *) PATH="${PATH:+$PATH:}$_gp_dir" ;;
    esac
  done <<EOF
$(guard_path_dirs)
EOF
  export PATH
}
