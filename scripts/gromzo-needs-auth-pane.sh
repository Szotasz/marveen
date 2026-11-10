# shellcheck shell=bash
# GROMZONEEDSAUTH1109 (Samu 74063, 74110; Dani 74108): the step of a respawn command that takes Claude Code's cached
# needs-auth entry for the Gromzo server out of the config dir the respawned claude will read. Sourced by
# channel-watchdog.sh and stuck-modal-guard.sh; the dashboard's respawns build the same group in TypeScript
# (gromzoNeedsAuthPaneStep in src/web/channel-monitor.ts, a test keeps the two equal), and channels.sh runs the helper
# directly after its kill-session.
#
# The step runs IN the pane, right before claude: after the respawn (with -k) killed the old claude (so that one cannot write
# the entry back) and after the command's own exports, so "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" is exactly the dir the
# new claude reads. Why the entry must go and what the helper never touches: src/web/gromzo-needs-auth.ts. The line goes
# to store/channels-failures.log; a missing helper or a failure never stops the respawn.
#
#   gromzo_needs_auth_pane_step <install dir> <channels arg>
# prints "{ ... } && " when the channels arg loads plugin:gromzo-channel@gromzo-local, nothing otherwise.
gromzo_needs_auth_pane_step() {
  case " $2 " in
    *" plugin:gromzo-channel@gromzo-local "*) ;;
    *) return 0 ;;
  esac
  local helper log
  helper="'$(printf '%s' "$1/scripts/gromzo-needs-auth-clear.mjs" | sed "s/'/'\\\\''/g")'"
  log="'$(printf '%s' "$1/store/channels-failures.log" | sed "s/'/'\\\\''/g")'"
  # shellcheck disable=SC2016 # the ${CLAUDE_CONFIG_DIR...} is for the pane's shell, not this one
  printf '{ [ ! -f %s ] || node %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" 2>>%s || true; } && ' "$helper" "$helper" "$log"
}
