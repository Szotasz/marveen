#!/bin/bash
# The install's time zone for shell helpers (ISSUE1895, #1895). Sourced, never executed.
#
# src/config.ts resolves ONE zone for the whole install (APP_TZ): SCHEDULER_TZ
# from store/config-overrides.json over .env, and the host zone when it is unset
# or not a real zone. Shell and Python helpers used to hardcode Europe/Budapest
# instead, so on an install anywhere else their stamps, prompts and plists ran
# an hour (or more) off the rest of the system. These two functions are the
# shell side of the same rule.
#
# Safe to source under `set -euo pipefail` and an ERR trap: every lookup that
# may fail is guarded, and nothing ends in a bare `a && b` list.

# install_tz_pinned [INSTALL_DIR] -- the zone the operator pinned (SCHEDULER_TZ,
# config-overrides.json over .env), only when it names a real zone; nothing
# otherwise. For places that must stay silent when no zone was pinned (a launchd
# plist then inherits the OS zone, exactly like the main units).
install_tz_pinned() {
  _itp_dir="${1:-${INSTALL_DIR:-}}"
  _itp_v=""
  if [ -n "$_itp_dir" ] && [ -f "$_itp_dir/store/config-overrides.json" ]; then
    _itp_v="$(grep -oE '"SCHEDULER_TZ"[[:space:]]*:[[:space:]]*"[^"]*"' "$_itp_dir/store/config-overrides.json" 2>/dev/null \
      | head -1 | sed -E 's/.*:[[:space:]]*"([^"]*)"$/\1/' || true)"
  fi
  if [ -z "$_itp_v" ] && [ -n "$_itp_dir" ] && [ -f "$_itp_dir/.env" ]; then
    # Parity with src/env-parse.ts: the last occurrence wins, CR and surrounding
    # whitespace dropped, one pair of surrounding quotes removed.
    _itp_v="$(grep -E '^[[:space:]]*SCHEDULER_TZ=' "$_itp_dir/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' \
      | sed -E -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//' -e 's/^"(.*)"$/\1/' -e "s/^'(.*)'\$/\1/" || true)"
  fi
  # A misspelled zone is worse than none (TZ=Bad/Zone makes `date` print UTC
  # without a word); config.ts drops it the same way. A real IANA zone is a file
  # under /usr/share/zoneinfo on both macOS and Linux.
  case "$_itp_v" in
    ''|*..*|/*) _itp_v="" ;;
    *) if [ ! -f "/usr/share/zoneinfo/$_itp_v" ]; then _itp_v=""; fi ;;
  esac
  printf '%s' "$_itp_v"
  unset _itp_dir _itp_v
}

# host_tz -- the process's own zone, or nothing when it cannot be read. The TZ
# environment comes first, as for config.ts (Intl reads it) and usage-collect.py:
# a container or a unit with Environment=TZ=... has its zone there, not in /etc.
# Only a zone name with a "/" that exists under zoneinfo counts (usage-collect.py's
# test, plus the same existence check install_tz_pinned does); anything else
# falls through to the OS lookups.
host_tz() {
  _ht_v="${TZ:-}"
  _ht_v="${_ht_v#:}"
  case "$_ht_v" in
    */*) case "$_ht_v" in *..*|/*) _ht_v="" ;; *) if [ ! -f "/usr/share/zoneinfo/$_ht_v" ]; then _ht_v=""; fi ;; esac ;;
    *) _ht_v="" ;;
  esac
  if [ -z "$_ht_v" ]; then _ht_v="$(timedatectl show -p Timezone --value 2>/dev/null || true)"; fi
  if [ -z "$_ht_v" ] && [ -f /etc/timezone ]; then _ht_v="$(head -1 /etc/timezone 2>/dev/null || true)"; fi
  if [ -z "$_ht_v" ]; then _ht_v="$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*/zoneinfo/##p' || true)"; fi
  printf '%s' "$_ht_v"
  unset _ht_v
}

# install_tz [INSTALL_DIR] -- the install's zone, the same answer as APP_TZ:
# the pinned zone, else the host zone. Empty only when neither can be read.
install_tz() {
  _it_v="$(install_tz_pinned "${1:-${INSTALL_DIR:-}}")"
  if [ -z "$_it_v" ]; then _it_v="$(host_tz)"; fi
  printf '%s' "$_it_v"
  unset _it_v
}
