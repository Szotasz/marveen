# shellcheck shell=sh
# Shared launchd label for the macOS helper installers (#1873). Sourced, not run.
#
# The main units are com.${SERVICE_ID}.dashboard / .channels (install-macos.sh),
# and the progress watchdogs follow the same scheme, but the helper installers
# (keepalive probe, main-inbox observer, stuck-modal guard, channel coordinator)
# wrote a FIXED com.marveen.<name> label. Two installs under one user then shared
# one plist per helper: the last installer to run pointed it at its own tree, and
# the other install silently lost its helper. The label now keys off the
# install's own SERVICE_ID, read from its .env the same way
# install-telegram-progress-hook.sh does (SERVICE_ID, else MAIN_AGENT_ID, else
# marveen). On a default install that is still com.marveen.<name>: nothing moves.

# Read one key from a .env file without sourcing it (sourcing would execute it).
_launchd_label_read_env() { # <file> <key>
  _lle_v="$(grep -E "^${2}=" "$1" 2>/dev/null | tail -1)" || return 0
  _lle_v="${_lle_v#*=}"
  case "$_lle_v" in
    '"'*) _lle_v="${_lle_v#\"}"; _lle_v="${_lle_v%\"}" ;;
    "'"*) _lle_v="${_lle_v#\'}"; _lle_v="${_lle_v%\'}" ;;
  esac
  printf '%s' "$_lle_v"
}

# helper_launchd_label <project_dir> <name> -> prints com.<service-id>.<name>
# MARVEEN_ENV_FILE overrides the .env path (tests only, as in the progress hooks).
helper_launchd_label() {
  _hll_env="${MARVEEN_ENV_FILE:-$1/.env}"
  _hll_id=""
  if [ -f "$_hll_env" ]; then
    _hll_id="$(_launchd_label_read_env "$_hll_env" SERVICE_ID)"
    [ -n "$_hll_id" ] || _hll_id="$(_launchd_label_read_env "$_hll_env" MAIN_AGENT_ID)"
  fi
  # The id becomes part of a file name and a launchd label: only the slug shape
  # the installer itself produces is accepted. Anything else falls back to the
  # default, and says so -- a silent fallback would hide a second collision.
  case "$_hll_id" in
    '') _hll_id="marveen" ;;
    *[!A-Za-z0-9_-]*|-*)
      echo "WARN: SERVICE_ID '$_hll_id' is not a valid label part; using 'marveen'" >&2
      _hll_id="marveen" ;;
  esac
  printf 'com.%s.%s' "$_hll_id" "$2"
}

# retire_legacy_helper_label <project_dir> <name> <new_label> <plist_dir>
# One-time migration for a renamed install that still has the old shared
# com.marveen.<name> job. It is retired ONLY when that plist points at THIS
# install (its WorkingDirectory is <project_dir>): a com.marveen.<name> job that
# belongs to another install on the same host is left alone.
retire_legacy_helper_label() {
  _rhl_old="com.marveen.$2"
  [ "$3" = "$_rhl_old" ] && return 0
  _rhl_plist="$4/$_rhl_old.plist"
  [ -f "$_rhl_plist" ] || return 0
  grep -qF "<string>$1</string>" "$_rhl_plist" || return 0
  launchctl bootout "gui/$(id -u)/$_rhl_old" >/dev/null 2>&1 \
    || launchctl unload "$_rhl_plist" >/dev/null 2>&1 \
    || true
  rm -f "$_rhl_plist"
  echo "  Régi, közös launchd-címke kivezetve: $_rhl_old (ennek a telepítésnek most: $3)"
}
