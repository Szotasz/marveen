# shellcheck shell=bash
# Wait for the channel providers' hosts to resolve before the main session
# starts (BOOTSTAGGER1007 (a)). Sourced by scripts/channels.sh.
#
# MEASURED 2026-10-07 after a power cut: launchd started the main session at
# 15:58:19 while DNS was not up yet. The co-listen Slack plugin's MCP connect
# failed after its 60 s limit ("getaddrinfo ENOTFOUND slack.com", Claude Code's
# mcp-logs-plugin-slack-channel-slack), Claude Code does not retry a failed MCP
# connect, and the owner's main channel stayed deaf for 30 minutes until a
# manual reconnect. Waiting here, before claude starts, costs nothing when the
# network is up (one lookup per host) and prevents exactly that boot.
#
# Bounded: after CHANNEL_NET_WAIT_MAX_S the session starts anyway (a host that
# never resolves must not keep the bot down forever) and the wait says so.

# The provider a --channels plugin id belongs to: the part before '@', with the
# marketplace's "-channel" suffix dropped (slack-channel@... -> slack).
channel_provider_of_plugin() {
  local name="${1%%@*}"
  name="${name%-channel}"
  printf '%s\n' "$name"
}

# The hosts a provider's plugin must reach. Only the hosts our own code calls
# for that provider (src/channel-provider.ts), not guesses: a provider with no
# known host is reported and not waited on.
channel_hosts_for_provider() {
  case "$1" in
    telegram) echo "api.telegram.org" ;;
    slack)    echo "slack.com" ;;
    discord)  echo "discord.com" ;;
    *)        echo "" ;;
  esac
}

# Does $1 resolve? Through getaddrinfo, the call the plugins make (node's
# dns.lookup and python's socket.getaddrinfo both use it); getent where neither
# exists (Linux). CHANNEL_DNS_PROBE replaces the whole chain (tests).
# Exit 0 = resolves, 1 = does not, 2 = no resolver available.
channel_host_resolves() {
  local host="$1" _node
  if [ -n "${CHANNEL_DNS_PROBE:-}" ]; then
    "$CHANNEL_DNS_PROBE" "$host"
    return $?
  fi
  _node="$(command -v node 2>/dev/null || true)"
  if [ -n "$_node" ]; then
    "$_node" -e '
      const t = setTimeout(() => process.exit(1), 5000)
      require("dns").lookup(process.argv[1], (err) => { clearTimeout(t); process.exit(err ? 1 : 0) })
    ' "$host" >/dev/null 2>&1
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket,sys; socket.setdefaulttimeout(5); socket.getaddrinfo(sys.argv[1], 443)' "$host" >/dev/null 2>&1
    return $?
  fi
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$host" >/dev/null 2>&1
    return $?
  fi
  return 2
}

# The hosts to wait for: the primary provider's plus every co-listen plugin's
# (CHANNEL_PLUGINS_EXTRA). $1 = primary provider, rest = extra plugin ids.
channel_wait_hosts() {
  local primary="$1"; shift
  local p h seen=" "
  for p in "$primary" $(for x in "$@"; do channel_provider_of_plugin "$x"; done); do
    h="$(channel_hosts_for_provider "$p")"
    if [ -z "$h" ]; then
      echo "$(date '+%F %T') channel-net-wait: no known host for provider '$p', not waiting on it" >&2
      continue
    fi
    case "$seen" in *" $h "*) continue ;; esac
    seen="$seen$h "
    printf '%s\n' "$h"
  done
}

# Wait until every host resolves, at most CHANNEL_NET_WAIT_MAX_S seconds
# (default 120), polling every CHANNEL_NET_WAIT_INTERVAL_S (default 3).
# Returns 0 when all resolved, 1 when the limit ran out (the caller starts the
# session anyway). Logs to stderr: one line when it had to wait, one at the end.
wait_for_channel_hosts() {
  local max="${CHANNEL_NET_WAIT_MAX_S:-120}" interval="${CHANNEL_NET_WAIT_INTERVAL_S:-3}"
  local start now pending h rc waited=0
  [ "$#" -eq 0 ] && return 0
  start="$(date +%s)"
  while :; do
    pending=""
    for h in "$@"; do
      channel_host_resolves "$h"; rc=$?
      if [ "$rc" -eq 2 ]; then
        echo "$(date '+%F %T') channel-net-wait: no resolver (node, python3, getent) on PATH -- starting without the network wait" >&2
        return 0
      fi
      [ "$rc" -ne 0 ] && pending="$pending $h"
    done
    now="$(date +%s)"
    if [ -z "$pending" ]; then
      [ "$waited" -eq 1 ] && echo "$(date '+%F %T') channel-net-wait: all channel hosts resolve after $((now - start))s ($*)" >&2
      return 0
    fi
    if [ "$((now - start))" -ge "$max" ]; then
      echo "$(date '+%F %T') channel-net-wait: GAVE UP after $((now - start))s, still not resolving:$pending -- starting the session anyway" >&2
      return 1
    fi
    if [ "$waited" -eq 0 ]; then
      echo "$(date '+%F %T') channel-net-wait: waiting for$pending to resolve before starting the main session (max ${max}s)" >&2
      waited=1
    fi
    sleep "$interval"
  done
}
