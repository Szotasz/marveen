#!/bin/bash
# Unit PATH check for scripts/doctor.sh (BREWPREFIXREST1107, #1968 point 3). Sourced, never executed.
#
# Why: a launchd plist (macOS) or a systemd user unit (Linux) carries the PATH the
# installer wrote at install time. When tmux, claude or node lives in a dir that
# PATH does not have (a Homebrew in a custom prefix, a user-level install), the
# job cannot find it, and nothing said so: the services just crash-looped. This
# compares each unit's PATH with what `command -v` finds in the doctor's shell.
#
# The channels, dashboard and app units learn more dirs at run time (#2578:
# scripts/channels.sh and src/platform.ts knownBinDirs(): ~/.local/bin, the
# Homebrew prefix bin derived from the PATH's node@NN keg entry, ~/.bun/bin and the
# fixed dirs). Those count as on their PATH, or a re-run installer, which writes
# the same plist, could never clear the warning.
#
# The check only REPORTS. unit_path_check prints one "<level>|<message>" line per
# finding, level is ok, warn or skip: one warn line per tool, naming the missing
# dir, the units that lack it, and the fix.
# Args: unit_path_check <uname -s> <service id>. Reads $HOME and the caller's PATH.

# unit_path_of <unit file> -- the PATH value the unit sets, empty if none.
unit_path_of() {
  case "$1" in
    *.plist)
      awk '
        /<key>PATH<\/key>/ { want = 1; sub(/.*<key>PATH<\/key>/, "") }
        want && /<string>/ {
          sub(/.*<string>/, ""); sub(/<\/string>.*/, ""); print; exit
        }' "$1" 2>/dev/null ;;
    *)
      # systemd: Environment=PATH=... or Environment="PATH=...". The last one wins, as in systemd.
      awk '
        /^[[:space:]]*Environment="?PATH=/ {
          v = $0; sub(/^[[:space:]]*Environment="?PATH=/, "", v); sub(/"[[:space:]]*$/, "", v); p = v
        }
        END { if (p != "") print p }' "$1" 2>/dev/null ;;
  esac
}

# _upc_brew_prefix_bin <PATH> -- the #2578 rule: <prefix>/bin of the first node@NN keg entry
# (<prefix>/opt/node@NN/bin) whose <prefix>/bin exists and is not a fixed dir.
_upc_brew_prefix_bin() {
  printf '%s\n' "$1" | tr ':' '\n' | while IFS= read -r _upc_d; do
    case "$_upc_d" in
      /?*/opt/node@[0-9]/bin|/?*/opt/node@[0-9][0-9]/bin) ;;
      *) continue ;;
    esac
    _upc_b="${_upc_d%/opt/node@*/bin}/bin"
    case "$_upc_b" in
      /opt/homebrew/bin|/usr/local/bin|/usr/bin|/bin) continue ;;
    esac
    if [ -d "$_upc_b" ]; then
      printf '%s\n' "$_upc_b"
      break
    fi
  done
}

# _upc_fix <os> <unit suffix> -- the command that rewrites that unit.
_upc_fix() {
  case "$2" in
    channels|dashboard) echo "./install.sh" ;;
    app) echo "npm run setup" ;;
    *-progress-watchdog) echo "bash scripts/install-${2%-progress-watchdog}-progress-hook.sh" ;;
    *)
      if [ "$1" = "Darwin" ] && [ -f "${INSTALL_DIR:-.}/scripts/install-$2.sh" ]; then
        echo "bash scripts/install-$2.sh"
      else
        echo "./install.sh"
      fi ;;
  esac
}

unit_path_check() {
  _upc_os="$1"; _upc_sid="$2"
  _upc_units=""
  if [ "$_upc_os" = "Darwin" ]; then
    for _upc_f in "$HOME/Library/LaunchAgents/com.${_upc_sid}."*.plist "$HOME/Library/LaunchAgents/com.marveen.channel-outage-alarm.plist"; do
      [ -f "$_upc_f" ] || continue
      case "
$_upc_units
" in *"
$_upc_f
"*) continue ;; esac
      _upc_units="${_upc_units:+$_upc_units
}$_upc_f"
    done
  else
    for _upc_f in "$HOME/.config/systemd/user/${_upc_sid}-"*.service; do
      [ -f "$_upc_f" ] && _upc_units="${_upc_units:+$_upc_units
}$_upc_f"
    done
  fi
  if [ -z "$_upc_units" ]; then
    echo "skip|no installed unit found to compare"
    return 0
  fi

  _upc_warned=""
  for _upc_tool in tmux claude node; do
    _upc_bin="$(command -v "$_upc_tool" 2>/dev/null || true)"
    case "$_upc_bin" in /*) ;; *) continue ;; esac
    _upc_dir="${_upc_bin%/*}"; [ -n "$_upc_dir" ] || _upc_dir="/"
    _upc_lack=""; _upc_fixes=""
    while IFS= read -r _upc_f; do
      _upc_p="$(unit_path_of "$_upc_f")"
      [ -n "$_upc_p" ] || continue
      _upc_name="${_upc_f##*/}"; _upc_name="${_upc_name%.plist}"; _upc_name="${_upc_name%.service}"
      if [ "$_upc_os" = "Darwin" ]; then
        _upc_sfx="${_upc_name#com.${_upc_sid}.}"; [ "$_upc_sfx" != "$_upc_name" ] || _upc_sfx="${_upc_name#com.marveen.}"
      else
        _upc_sfx="${_upc_name#${_upc_sid}-}"
      fi
      case "$_upc_sfx" in
        channels|dashboard|app)
          _upc_bp="$(_upc_brew_prefix_bin "$_upc_p")"
          _upc_p="$_upc_p:$HOME/.local/bin${_upc_bp:+:$_upc_bp}:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" ;;
      esac
      case ":$_upc_p:" in
        *":$_upc_dir:"*|*":$_upc_dir/:"*) continue ;;
      esac
      _upc_lack="${_upc_lack:+$_upc_lack, }$_upc_name"
      _upc_fx="$(_upc_fix "$_upc_os" "$_upc_sfx")"
      case "; $_upc_fixes;" in *"; $_upc_fx;"*) ;; *) _upc_fixes="${_upc_fixes:+$_upc_fixes; }$_upc_fx" ;; esac
    done <<EOF
$_upc_units
EOF
    if [ -n "$_upc_lack" ]; then
      echo "warn|$_upc_tool: $_upc_dir (where $_upc_bin is) is not on the PATH of $_upc_lack, so these jobs may not find it. Fix: $_upc_fixes"
      _upc_warned=1
    fi
  done
  [ -n "$_upc_warned" ] || echo "ok|tmux, claude and node are on the PATH of every installed unit"
  return 0
}
