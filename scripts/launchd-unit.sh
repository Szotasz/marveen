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

# start_launchd_periodic_unit PLIST LABEL -- (re)register a PERIODIC helper job
# (StartInterval) in the GUI domain, run it once, then VERIFY it ran.
# Echoes the job's run count (>= 1), or nothing when it is not running.
#
# ISSUE1891 (#1891): the three helper jobs (keep-alive probe, stuck-modal guard,
# main-inbox observer) used a bare `launchctl unload; launchctl load` and then
# printed "Loaded" unconditionally. A periodic job has no lasting pid, so
# start_launchd_unit's pid check does not fit it; what proves it is live is
# that it is registered in gui/<uid> and its `runs` count is at least 1.
# Measured on 26.x with a throwaway StartInterval job: bootstrap rc=0 and
# runs = 1 at once (RunAtLoad), kickstart -> runs = 2, bootout followed at once
# by bootstrap rc=0, and bootstrap of a job that is still registered rc=5 (EIO),
# hence the bootout first.
# Without a GUI login session (an install driven over SSH) there is no gui/<uid>
# domain to register in -- launchctl(1): "Aqua agents are loaded only when a user
# has logged in at the GUI" -- and the job never runs; this then echoes nothing,
# so the caller can say so instead of claiming the job is loaded.
start_launchd_periodic_unit() {
  _slp_plist="$1"
  _slp_label="$2"
  _slp_domain="gui/$(id -u)"
  launchctl bootout "$_slp_domain/$_slp_label" >/dev/null 2>&1 \
    || launchctl unload "$_slp_plist" >/dev/null 2>&1 \
    || true
  launchctl bootstrap "$_slp_domain" "$_slp_plist" >/dev/null 2>&1 \
    || launchctl load "$_slp_plist" >/dev/null 2>&1 \
    || true
  launchctl kickstart "$_slp_domain/$_slp_label" >/dev/null 2>&1 || true
  _slp_runs=""
  _slp_try=0
  while [ "$_slp_try" -lt "${LAUNCHD_START_TRIES:-10}" ]; do
    # `|| true` inside: the installers run with pipefail, and `print` fails when
    # there is no gui/<uid> at all -- that must read as "not running", not abort.
    _slp_runs="$( { launchctl print "$_slp_domain/$_slp_label" 2>/dev/null || true; } \
      | awk '/^\truns = /{print $3; exit}')"
    # `case`, not `[ ... -ge 1 ] && break`: errexit-safe, and a non-number never counts.
    case "$_slp_runs" in
      ''|*[!0-9]*|0) _slp_runs="" ;;
      *) break ;;
    esac
    _slp_try=$((_slp_try + 1))
    sleep 1
  done
  printf '%s' "$_slp_runs"
  unset _slp_plist _slp_label _slp_domain _slp_try
}

# The remedy for a helper job that is not running, run from a terminal of the
# GUI login session (the only place gui/<uid> exists). bootstrap first (it
# registers and runs it; harmless if already registered), then kickstart.
print_periodic_unit_remedy() {
  printf '    launchctl bootstrap gui/%s "%s" 2>/dev/null; launchctl kickstart gui/%s/%s\n' \
    "$(id -u)" "$1" "$(id -u)" "$2"
}
