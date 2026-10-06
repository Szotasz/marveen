#!/bin/bash
# FLEETVENV923: the shell side of the fleet venv PATH prefix, shared by EVERY
# shell launcher (channels.sh boot, watchdog.sh sub-agent restart,
# channel-watchdog.sh and stuck-modal-guard.sh main respawns, the
# morning-briefing.sh fallback), so none of them
# parses FLEET_PYTHON_VENV on its own. src/__tests__/launch-path-venv-pin.test.ts
# pins which files build a launch `export PATH=`. The value comes from
# scripts/fleet-venv-prefix.mjs, i.e. from the same dist/fleet-venv.js functions
# the TypeScript launchers use (Settings-page override > .env > off; absolute
# paths only). Source it, then:
#   PREFIX="$(fleet_venv_prefix "$INSTALL_DIR" [log_file])"
# Prints "<venv>/bin:" or nothing. No node or no dist yet = nothing, named in
# log_file when one is given. Never fails the caller.
fleet_venv_prefix() {
  local install_dir="$1" log="${2:-}" node_bin out
  node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ] || [ ! -f "$install_dir/dist/fleet-venv.js" ]; then
    if [ -n "$log" ]; then
      { echo "$(date '+%Y-%m-%d %H:%M:%S') fleet venv PATH prefix skipped (node or dist/fleet-venv.js missing)" >> "$log"; } 2>/dev/null || true
    fi
    return 0
  fi
  if [ -n "$log" ]; then
    out="$("$node_bin" "$install_dir/scripts/fleet-venv-prefix.mjs" 2>>"$log" || true)"
  else
    out="$("$node_bin" "$install_dir/scripts/fleet-venv-prefix.mjs" 2>/dev/null || true)"
  fi
  case "$out" in
    /*:) if [ -d "${out%:}" ]; then printf '%s' "$out"; fi ;;
  esac
  return 0
}
