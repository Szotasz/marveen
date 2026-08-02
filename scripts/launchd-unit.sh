#!/bin/bash
# Shared launchd starter for the macOS entry points (install-macos.sh and
# scripts/start.sh). Sourced, never executed.
#
# `launchctl load` is not `launchctl start`. It only PENDS a RunAtLoad spawn on
# modern macOS. Measured on 26.5.1 with a throwaway agent carrying
# RunAtLoad=true + KeepAlive=true:
#
#   launchctl load <plist>                rc=0, runs = 0, never starts
#   launchctl bootstrap gui/$UID <plist>  rc=0, runs = 0, never starts
#   launchctl print gui/$UID/<label>      "pended nondemand spawn = speculative",
#                                         still `state = not running` after 30s
#   launchctl kickstart gui/$UID/<label>  starts immediately, runs = 1
#
# Both call sites used to `launchctl load ... 2>/dev/null || true` and then print
# a success line unconditionally, so an install (or a manual start) ended with
# two units that had NEVER run while the operator was told they were up -- the
# bot answered nobody and nothing anywhere explained why.
#
# Safe to source into a script running with `set -e` and an exiting ERR trap:
# no bare `cmd && cmd` list is the last command of any construct here.

# start_launchd_unit LABEL -- bootstrap/load, kickstart, then VERIFY.
# Echoes the running pid, or nothing at all when the unit never came up.
# PLIST_DIR defaults to the user LaunchAgents directory.
start_launchd_unit() {
  _slu_label="$1"
  _slu_dir="${PLIST_DIR:-$HOME/Library/LaunchAgents}"
  _slu_domain="gui/$(id -u)"
  launchctl bootstrap "$_slu_domain" "$_slu_dir/${_slu_label}.plist" 2>/dev/null \
    || launchctl load "$_slu_dir/${_slu_label}.plist" 2>/dev/null \
    || true
  launchctl kickstart "$_slu_domain/${_slu_label}" >/dev/null 2>&1 || true
  _slu_pid=""
  _slu_try=0
  while [ "$_slu_try" -lt "${LAUNCHD_START_TRIES:-10}" ]; do
    _slu_pid="$(launchctl print "$_slu_domain/${_slu_label}" 2>/dev/null \
      | awk '/^\tpid = /{print $3; exit}')"
    # NOT `[ -n "$_slu_pid" ] && break`: as the last command of the loop body
    # that list would return 1 on the final miss and abort an errexit caller.
    if [ -n "$_slu_pid" ]; then break; fi
    _slu_try=$((_slu_try + 1))
    sleep 1
  done
  # A first pid is not proof the unit STAYED up. Measured with a unit whose
  # program does not exist: launchd reports a transient `state = xpcproxy` pid
  # for about a second, and only two seconds on does it read
  # `state = spawn scheduled`, no pid, `last exit code = 78: EX_CONFIG`. Confirm
  # after a settle so a crash-looping unit is not counted as started.
  if [ -n "$_slu_pid" ]; then
    sleep 2
    _slu_pid="$(launchctl print "$_slu_domain/${_slu_label}" 2>/dev/null \
      | awk '/^\tpid = /{print $3; exit}')"
  fi
  printf '%s' "$_slu_pid"
  unset _slu_label _slu_dir _slu_domain _slu_try
}
