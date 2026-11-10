# shellcheck shell=bash
# GROMZOMAINAGENT1106: the main agent on Gromzo, for every shell launcher of the main session
# (channels.sh, channel-watchdog.sh, stuck-modal-guard.sh). src/web/main-gromzo-launch.ts is the TS twin
# (channel-monitor respawns, the isolated main config); a test runs both on the same inputs.
#
# The gromzo-channel plugin is listed in .env CHANNEL_PLUGINS_EXTRA by the dashboard once the owner has
# approved the main agent in the app. Two rules keep it safe and quiet:
#  - It loads only when mxd's agent.sock is usable by this user (read AND write, as for a sub-agent:
#    agent-extra-channels.ts mxdAgentSockUsable) and the main agent's id passes mxd's slug rule. Otherwise
#    the id is dropped from the launch: no plugin that exits at once, and a Bridge uninstall leaves nothing
#    that half-starts.
#  - The plugin names itself with MXD_AGENT. That goes in as an export in THIS launch command only, never
#    into a settings.json: the shared ~/.claude/settings.json env is copied into every sub-agent's config,
#    and a sub-agent's plugin would then say hello as the main agent (GROMZOMAINAGENT1106 EGM, design 1).
#    MXD_SCOPE=both: the owner DM and the team, as for every Gromzo agent (owner 2026-10-31).

MAIN_GROMZO_PLUGIN_ID='gromzo-channel@gromzo-local'

# The plugin's own default socket (plugin/gromzo-channel; agent-extra-channels.ts MXD_AGENT_SOCK_DEFAULT).
# MAIN_GROMZO_SOCK_PATH overrides it for the tests only.
main_gromzo_sock() {
  if [ -n "${MAIN_GROMZO_SOCK_PATH:-}" ]; then
    printf '%s' "$MAIN_GROMZO_SOCK_PATH"
  elif [ "$(uname -s)" = Darwin ]; then
    printf '%s' '/Library/Application Support/Marveen/mxd-run/agent.sock'
  else
    printf '%s' '/run/marveen-mxd/agent.sock'
  fi
}

# main_gromzo_slug <main_agent_id>: the slug (default marveen, as src/config.ts), or nothing and rc 1 when
# it fails mxd's rule (lower-case letters, digits, '-', 1-32).
main_gromzo_slug() {
  local s="${1:-marveen}"
  # The class is spelled out, never a-z: macOS /bin/bash 3.2 under a UTF-8 locale lets a range match
  # 'B' and accented letters (measured 2026-11-06), and the launchers run with the owner's locale.
  case "$s" in ''|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*) return 1 ;; esac
  [ "${#s}" -le 32 ] || return 1
  printf '%s' "$s"
}

# main_gromzo_usable <main_agent_id>: rc 0 when the plugin may load for the main session.
main_gromzo_usable() {
  local sock
  main_gromzo_slug "$1" >/dev/null || return 1
  sock="$(main_gromzo_sock)"
  # Read AND write, exactly mxdAgentSockUsable (accessSync R_OK|W_OK): the twin test holds the two equal.
  [ -r "$sock" ] && [ -w "$sock" ]
}

# main_gromzo_filter_ids <main_agent_id> [id ...]: the ids, space-separated, the gromzo id dropped when it
# may not load. Every other id passes unchanged and in order.
main_gromzo_filter_ids() {
  local main="$1" out="" usable=1 i
  shift
  main_gromzo_usable "$main" && usable=0
  for i in "$@"; do
    [ -n "$i" ] || continue
    if [ "$i" = "$MAIN_GROMZO_PLUGIN_ID" ] && [ "$usable" -ne 0 ]; then continue; fi
    out="$out $i"
  done
  printf '%s' "${out# }"
}

# main_gromzo_token_file <slug>: MXDAGENTSOCKID1106, the agent's token file <agent.sock's dir>/tokens/<slug>.token,
# only when mxd has the tokens dir (an older mxd has none: then no path, or the plugin would wait for a file
# that never comes). The twin of agent-extra-channels.ts gromzoTokenFile; nothing printed otherwise.
main_gromzo_token_file() {
  local sock dir
  sock="$(main_gromzo_sock)"
  dir="$(dirname "$sock")/tokens"
  [ -d "$dir" ] || return 0
  case "$dir" in *'"'*|*'$'*|*'`'*|*'\'*) return 0 ;; esac
  printf '%s/%s.token' "$dir" "$1"
}

# GROMZOPLUGREG1109 (Samu 73877): the plugin must also be REGISTERED for Claude Code, in the shared
# ~/.claude/plugins/installed_plugins.json the dashboard writes (gromzo-marketplace.ts ensureGromzoMarketplace; an
# isolated main config is seeded from it on every start). Measured on the QA VPS 11-09: with the plugin step left out,
# the main agent enrolled, the session was started with --channels plugin:gromzo-channel@gromzo-local, no plugin
# server ever ran, and the dashboard's down cascade restarted the session: the loop A1 removes, through another input.
# A plain substring on the plugin key, the same test as the TS twin (Claude Code writes the key only as a plugin key).
# MAIN_GROMZO_PLUGINS_FILE overrides the path for the tests only.
main_gromzo_plugins_file() {
  if [ -n "${MAIN_GROMZO_PLUGINS_FILE:-}" ]; then
    printf '%s' "$MAIN_GROMZO_PLUGINS_FILE"
  else
    printf '%s' "$HOME/.claude/plugins/installed_plugins.json"
  fi
}
main_gromzo_plugin_registered() {
  local f
  f="$(main_gromzo_plugins_file)"
  [ -r "$f" ] && grep -qF "\"$MAIN_GROMZO_PLUGIN_ID\"" "$f"
}

# main_gromzo_pending_reason <main_agent_id>: why the Gromzo plugin may NOT be the main agent's primary channel yet, as
# one word (bad_slug, mxd_socket, not_enrolled, plugin_not_registered), or nothing when it may. The TS twin is
# main-gromzo-launch.ts mainGromzoPendingReason; a test runs both on the same inputs.
main_gromzo_pending_reason() {
  local slug tf
  slug="$(main_gromzo_slug "$1")" || { printf 'bad_slug'; return 0; }
  main_gromzo_usable "$1" || { printf 'mxd_socket'; return 0; }
  tf="$(main_gromzo_token_file "$slug")"
  { [ -n "$tf" ] && [ -r "$tf" ] && [ -s "$tf" ]; } || { printf 'not_enrolled'; return 0; }
  main_gromzo_plugin_registered || { printf 'plugin_not_registered'; return 0; }
  return 0
}

# GROMZONOPROVIDER1108: main_gromzo_primary_ready <main_agent_id>: the Gromzo plugin may be the main agent's
# PRIMARY channel (CHANNEL_PROVIDER=gromzo) only when mxd's agent socket is usable, the main agent is enrolled (its
# token file exists, readable and not empty: mxd writes a token only for an agent it runs, after the owner's consent;
# a held or not yet approved agent has none; NOT the .env CHANNEL_PLUGINS_EXTRA flag, that is no consent signal) AND
# the plugin is registered (GROMZOPLUGREG1109). Every reason in main_gromzo_pending_reason.
main_gromzo_primary_ready() {
  [ -z "$(main_gromzo_pending_reason "$1")" ]
}

# main_gromzo_env <main_agent_id> [id ...]: the launch-command prefix when the (filtered) ids carry the
# gromzo plugin, else nothing. Ends in "&& " like the other prefixes of the launch command.
# MXDAGENTSOCKID1106: with the token path (MXD_AGENT_TOKEN_FILE) when mxd has one, so a protected agent binds.
main_gromzo_env() {
  local main="$1" i slug tf
  shift
  for i in "$@"; do
    if [ "$i" = "$MAIN_GROMZO_PLUGIN_ID" ]; then
      slug="$(main_gromzo_slug "$main")" || return 0
      printf 'export MXD_AGENT="%s" && export MXD_SCOPE="both" && ' "$slug"
      tf="$(main_gromzo_token_file "$slug")"
      [ -z "$tf" ] || printf 'export MXD_AGENT_TOKEN_FILE="%s" && ' "$tf"
      return 0
    fi
  done
}
