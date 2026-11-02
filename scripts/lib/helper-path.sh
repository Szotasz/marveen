#!/bin/bash
# The PATH of the periodic helper plists. Sourced, never executed.
#
# install-channel-keepalive-probe.sh and install-main-inbox-observer.sh wrote a
# fixed PATH into their plists. A tmux that lives outside that list (a user-level
# install in ~/.local/bin, say) was then invisible to the probe's `command -v
# tmux`: "tmux not on PATH", a keepalive that never advanced, and a stale alarm
# that respawned a healthy session. The channels and dashboard plists already
# carry the dir; this is the same rule for the helpers.
#
# Safe to source under `set -euo pipefail` and an ERR trap: every lookup that may
# fail is guarded, and nothing ends in a bare `a && b` list. Builtins only, so it
# works with an empty PATH too.

HELPER_PATH_BASE="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# helper_launchd_path [TMUX] -- the PATH value for a helper plist: the fixed list,
# with the dir tmux was found in put in front when that dir is not already on it.
# TMUX is the absolute path of the tmux binary; without it the installer's PATH is
# searched first, then ~/.local/bin (a non-interactive SSH install does not have it
# on PATH). A tmux in a listed dir, no tmux, a relative hit, or a dir that cannot
# sit in a PATH value all give the fixed list, byte for byte; the last of those says
# so on stderr (HELPER-PATH-ELVETVE).
helper_launchd_path() {
  _hlp_tmux="${1:-}"
  if [ -z "$_hlp_tmux" ]; then
    _hlp_tmux="$(PATH="${PATH:+$PATH:}${HOME:-}/.local/bin" command -v tmux 2>/dev/null || true)"
  fi
  case "$_hlp_tmux" in
    /*) ;;
    *) printf '%s\n' "$HELPER_PATH_BASE"; return 0 ;;
  esac
  _hlp_dir="${_hlp_tmux%/*}"
  _hlp_nl='
'
  case "$_hlp_dir" in
    ""|*:*|*"<"*|*">"*|*"&"*|*'"'*|*"'"*|*"$_hlp_nl"*)
      echo "HELPER-PATH-ELVETVE: the dir of $_hlp_tmux cannot go into a PATH value; the fixed list stays" >&2
      printf '%s\n' "$HELPER_PATH_BASE"
      return 0 ;;
  esac
  case ":$HELPER_PATH_BASE:" in
    *":$_hlp_dir:"*) printf '%s\n' "$HELPER_PATH_BASE" ;;
    *) printf '%s\n' "$_hlp_dir:$HELPER_PATH_BASE" ;;
  esac
}
