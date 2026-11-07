// Which inherited credentials a sub-agent's launch must strip (BYOSUBUNSET1018).
//
// Every agent pane is a new session on the fleet's tmux server, and a new
// session inherits the server's GLOBAL env -- measured 2026-10-18: a session
// started from a client env WITHOUT CLAUDE_CODE_OAUTH_TOKEN still had it.
// channels.sh puts the fleet token there, and ANTHROPIC_API_KEY on a key-only
// install (APIKEYSCOPE1107; older versions: whenever .env had one). Both outrank a /login credential (Claude Code docs, "Authentication
// precedence"; the API key ranks above the OAuth token as well), so an agent
// meant to authenticate some OTHER way silently runs on whichever of the two
// the server carries. The main agent's own-login path drops both (#2039,
// #2060); this is the sub-agent side.
//
// The cases:
// - not a Claude-OAuth agent (BYO/custom endpoint, authMode 'api'): drop the
//   OAuth token only. ANTHROPIC_API_KEY stays: an 'api' agent with no vault
//   key of its own runs on the inherited host key, and a custom provider sets
//   or unsets the key itself later in the launch.
// - authMode 'own_team', an operator-configured config dir (agent-config
//   claudeConfigDir or a configDir-mode plan) or the agent's own token file:
//   the agent authenticates with ITS credential, so both go. An own token
//   file is exported again later in the launch, after this unset.
// - otherwise (a fleet agent): it runs on what the server carries, EXCEPT an ANTHROPIC_API_KEY on a subscription
//   install (APIKEYSCOPE1107): there the key is an extra that outranks the fleet token (every pane would stop at
//   "Detected a custom API key", every `claude -p` would bill it; measured 2026-11-07, CLI 2.1.319), so it is
//   unset; channels.sh no longer puts it in the global env either, this covers an older server. On a key-only
//   install the key IS the fleet's credential and stays.

export interface InheritedAuthUnsetInput {
  needsFleetOauth: boolean
  isOwnTeam: boolean
  /** claudeConfigDir set by the operator (agent-config or a plan), not auto-isolated. */
  configuredConfigDir: boolean
  ownTokenFile: boolean
  /** The install's auth mode (src/web/auth-key-mode.ts). Absent = subscription, the safe side. */
  keyMode?: 'subscription' | 'keyonly' | 'none'
}

export function inheritedAuthUnset(i: InheritedAuthUnsetInput): string {
  if (i.isOwnTeam || (i.needsFleetOauth && (i.configuredConfigDir || i.ownTokenFile))) {
    return 'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && '
  }
  if (!i.needsFleetOauth) return 'unset CLAUDE_CODE_OAUTH_TOKEN && '
  return i.keyMode === 'keyonly' ? '' : 'unset ANTHROPIC_API_KEY && '
}
