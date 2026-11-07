#!/bin/bash
# Export an install's .env into the current shell. Sourced, never executed.
#
# The scripts used to load .env with `export $(grep -v '^#' .env | xargs)`. The
# unquoted $(...) is word-split AFTER xargs has removed the quotes, so a correctly
# quoted value with a space (OWNER_NAME="Ada Lovelace") became two words: the
# second one was handed to `export` as a name, which fails with "not a valid
# identifier" (measured 2026-11-07 in the morning-briefing journal), and the
# first one exported a truncated value. A value with a glob character could also
# expand against the cwd.
#
# load_env_file mirrors src/env-parse.ts: blank lines and # comments skipped, key
# and value trimmed (CR included), ONE pair of matching surrounding quotes
# stripped, later lines win. Lines whose key is not a shell identifier are
# skipped. Nothing in the file is ever evaluated: no $(...), no backticks, no
# variable expansion, no globbing.
#
# Safe to source under `set -euo pipefail`.

# load_env_file FILE -- export every KEY=VALUE line of FILE. A missing file is
# not an error (returns 0, exports nothing).
load_env_file() {
  local _le_file="$1" _le_line _le_key _le_val
  [ -f "$_le_file" ] || return 0
  while IFS= read -r _le_line || [ -n "$_le_line" ]; do
    _le_line="${_le_line//$'\r'/}"
    # trim leading/trailing whitespace
    _le_line="${_le_line#"${_le_line%%[![:space:]]*}"}"
    _le_line="${_le_line%"${_le_line##*[![:space:]]}"}"
    case "$_le_line" in ''|'#'*) continue ;; esac
    case "$_le_line" in *=*) ;; *) continue ;; esac
    _le_key="${_le_line%%=*}"
    _le_key="${_le_key%"${_le_key##*[![:space:]]}"}"
    _le_val="${_le_line#*=}"
    _le_val="${_le_val#"${_le_val%%[![:space:]]*}"}"
    [[ "$_le_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [ "${#_le_val}" -ge 2 ]; then
      case "$_le_val" in
        \"*\"|\'*\') _le_val="${_le_val:1:${#_le_val}-2}" ;;
      esac
    fi
    export "$_le_key=$_le_val"
  done < "$_le_file"
  return 0
}
