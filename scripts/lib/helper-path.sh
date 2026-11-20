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

# _helper_path_dir_bad DIR KIND -- the owner/mode rule for one existing directory: prints why it
# fails, nothing when it passes. Owned by the installing user ($EUID) or root, writable by neither
# the group (on macOS the admin group may) nor others; KIND=ancestor also passes a writable dir with the sticky bit (/private/tmp,
# /tmp: there only an entry's owner can rename the entry). $EUID and an absolute find:
# helper_launchd_path also runs under an empty PATH (builtins only).
_helper_path_dir_bad() {
  if [ -z "$(/usr/bin/find "$1" -maxdepth 0 \( -user "$EUID" -o -user 0 \) 2>/dev/null)" ]; then
    echo "is owned by neither the installing user nor root"; return 0
  fi
  if [ "$2" = ancestor ] && [ -n "$(/usr/bin/find "$1" -maxdepth 0 -perm -1000 2>/dev/null)" ]; then return 0; fi
  # macOS only: write access for the admin group (gid 80) does not count, its members can sudo
  # anyway (Homebrew keeps its bin drwxrwxr-x <user>:admin). Any other group still counts, and
  # writable by others always does.
  _hdb_admin=""
  if [ -n "$(/usr/bin/find "$1" -maxdepth 0 -perm -020 2>/dev/null)" ]; then
    if [ "$(/usr/bin/uname -s 2>/dev/null)" != "Darwin" ] || [ -z "$(/usr/bin/find "$1" -maxdepth 0 -group 80 2>/dev/null)" ]; then
      echo "is group-writable"; return 0
    fi
    _hdb_admin=1
  fi
  if [ -n "$(/usr/bin/find "$1" -maxdepth 0 -perm -002 2>/dev/null)" ]; then echo "is writable by others"; return 0; fi
  # passed only through the admin exception: say so (on a machine with several admins it shows)
  if [ -n "$_hdb_admin" ]; then
    echo "HELPER-PATH-ADMIN: $1 is writable by the admin group (gid 80); allowed on macOS, its members can sudo" >&2
  fi
  return 0
}

# _helper_path_unsafe DIR -- PATHDIROWNER1120: prints why DIR must not lead a launchd
# PATH, nothing when it may. A learned dir goes in FRONT of the fixed list, so whoever
# can write it decides what tmux/claude/node the job runs: it must be a real directory
# (not a symlink) that passes _helper_path_dir_bad, and so must every ancestor up to /
# (R1, Dani: whoever can write a parent can rename the dir away and put their own in its
# place). The ancestors of both spellings are checked: the path as given (a symlinked
# ancestor such as /var is skipped, its own parent is on the list) and the physical one
# (pwd -P, where the symlinks lead). The fixed list itself is not checked.
_helper_path_unsafe() {
  # a relative path would never reach / in the ancestor walk below
  case "$1" in /*) ;; *) echo "is not an absolute path"; return 0 ;; esac
  if [ -L "$1" ]; then echo "is a symlink"; return 0; fi
  if [ ! -d "$1" ]; then echo "is not a directory"; return 0; fi
  _hpu_why="$(_helper_path_dir_bad "$1" leaf)"
  if [ -n "$_hpu_why" ]; then echo "$_hpu_why"; return 0; fi
  _hpu_phys="$(cd -P "$1" 2>/dev/null && pwd -P)" || _hpu_phys=""
  if [ -z "$_hpu_phys" ]; then echo "cannot be resolved"; return 0; fi
  # the real path only when it differs (one walk, one note per dir, in the common case)
  [ "$_hpu_phys" = "$1" ] && _hpu_phys=""
  for _hpu_a in "$1" ${_hpu_phys:+"$_hpu_phys"}; do
    while [ "$_hpu_a" != "/" ]; do
      _hpu_a="${_hpu_a%/*}"; [ -n "$_hpu_a" ] || _hpu_a="/"
      [ -L "$_hpu_a" ] && continue
      _hpu_why="$(_helper_path_dir_bad "$_hpu_a" ancestor)"
      if [ -n "$_hpu_why" ]; then echo "has a parent $_hpu_a that $_hpu_why"; return 0; fi
    done
  done
  return 0
}

# _helper_path_learn DIR WHAT -- appends "DIR:" to _hlp_learned when DIR is neither
# on the fixed list nor already learned; a DIR that cannot sit in a PATH value, or
# that _helper_path_unsafe refuses, is left out and says so on stderr
# (HELPER-PATH-ELVETVE), naming it as WHAT and the reason.
_helper_path_learn() {
  case "$1" in
    ""|*:*|*"<"*|*">"*|*"&"*|*'"'*|*"'"*|*[[:cntrl:]]*)
      echo "HELPER-PATH-ELVETVE: $2 cannot go into a PATH value; it is left out" >&2
      return 0 ;;
  esac
  case ":$_hlp_learned$HELPER_PATH_BASE:" in
    *":$1:"*) return 0 ;;
  esac
  _hpl_why="$(_helper_path_unsafe "$1")"
  if [ -n "$_hpl_why" ]; then
    echo "HELPER-PATH-ELVETVE: $2 $_hpl_why; it is left out of the PATH" >&2
    return 0
  fi
  _hlp_learned="$_hlp_learned$1:"
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
