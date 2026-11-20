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

# ISSUE1968BREWPREFIX (#1968): a Homebrew in a custom prefix keeps tmux, claude and npm in <prefix>/bin.
# helper_brew_prefix_bin prints that dir, by the rule scripts/channels.sh and src/platform.ts brewPrefixBin
# apply: the first PATH entry <prefix>/opt/node@NN/bin (node@22's keg, which every launchd PATH the installer
# wrote starts with) whose <prefix>/bin exists and is not one of the fixed dirs. Nothing when there is none.
helper_brew_prefix_bin() {
  _hbp_rest="${PATH:-}:"
  while [ -n "$_hbp_rest" ]; do
    _hbp_dir="${_hbp_rest%%:*}"
    _hbp_rest="${_hbp_rest#*:}"
    case "$_hbp_dir" in
      /?*/opt/node@[0-9]/bin|/?*/opt/node@[0-9][0-9]/bin) ;;
      *) continue ;;
    esac
    _hbp_bin="${_hbp_dir%/opt/node@*/bin}/bin"
    case ":$HELPER_PATH_BASE:" in
      *":$_hbp_bin:"*) continue ;;
    esac
    if [ -d "$_hbp_bin" ]; then
      printf '%s\n' "$_hbp_bin"
      return 0
    fi
  done
  return 0
}

# _helper_path_learn DIR WHAT -- appends "DIR:" to _hlp_learned when DIR is neither
# on the fixed list nor already learned; a DIR that cannot sit in a PATH value is
# left out and says so on stderr (HELPER-PATH-ELVETVE), naming it as WHAT.
_helper_path_learn() {
  case "$1" in
    ""|*:*|*"<"*|*">"*|*"&"*|*'"'*|*"'"*|*[[:cntrl:]]*)
      echo "HELPER-PATH-ELVETVE: $2 cannot go into a PATH value; it is left out" >&2
      return 0 ;;
  esac
  case ":$_hlp_learned$HELPER_PATH_BASE:" in
    *":$1:"*) ;;
    *) _hlp_learned="$_hlp_learned$1:" ;;
  esac
}

# helper_launchd_path [TMUX] -- the PATH value for a helper plist: the fixed list,
# with the learned dirs put in front when they are not already on it: first the dir
# tmux was found in, then the custom Homebrew prefix bin (helper_brew_prefix_bin).
# TMUX is the absolute path of the tmux binary; without it the installer's PATH is
# searched first, then ~/.local/bin (a non-interactive SSH install does not have it
# on PATH). A tmux in a listed dir, no tmux, a relative hit, or a dir that cannot
# sit in a PATH value add nothing; the last of those says so on stderr
# (HELPER-PATH-ELVETVE); a control character (newline, tab, CR) counts. With no
# custom prefix either, the fixed list comes out byte for byte.
helper_launchd_path() {
  _hlp_tmux="${1:-}"
  if [ -z "$_hlp_tmux" ]; then
    _hlp_tmux="$(PATH="${PATH:+$PATH:}${HOME:-}/.local/bin" command -v tmux 2>/dev/null || true)"
    # A lookup may answer with a file that is not executable, or a dir (bash 3.2 may; not measured).
    if [ ! -x "$_hlp_tmux" ] || [ -d "$_hlp_tmux" ]; then
      _hlp_tmux=""
    fi
  fi
  _hlp_learned=""
  case "$_hlp_tmux" in
    /*) _helper_path_learn "${_hlp_tmux%/*}" "the dir of $_hlp_tmux" ;;
  esac
  _hlp_brew="$(helper_brew_prefix_bin)"
  if [ -n "$_hlp_brew" ]; then
    _helper_path_learn "$_hlp_brew" "the Homebrew prefix bin $_hlp_brew"
  fi
  printf '%s\n' "$_hlp_learned$HELPER_PATH_BASE"
}
