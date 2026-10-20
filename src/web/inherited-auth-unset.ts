// Which inherited credentials a sub-agent's launch must strip (BYOSUBUNSET1018).
//
// Every agent pane is a new session on the fleet's tmux server, and a new
// session inherits the server's GLOBAL env -- measured 2026-10-18: a session
// started from a client env WITHOUT CLAUDE_CODE_OAUTH_TOKEN still had it.
// channels.sh puts the fleet token there, and ANTHROPIC_API_KEY too when .env
// has one. Both outrank a /login credential (Claude Code docs, "Authentication
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
// - otherwise (a fleet agent): nothing; it runs on what the server carries.

export interface InheritedAuthUnsetInput {
  needsFleetOauth: boolean
  isOwnTeam: boolean
  /** claudeConfigDir set by the operator (agent-config or a plan), not auto-isolated. */
  configuredConfigDir: boolean
  ownTokenFile: boolean
}

export function inheritedAuthUnset(i: InheritedAuthUnsetInput): string {
  if (i.isOwnTeam || (i.needsFleetOauth && (i.configuredConfigDir || i.ownTokenFile))) {
    return 'unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && '
  }
  if (!i.needsFleetOauth) return 'unset CLAUDE_CODE_OAUTH_TOKEN && '
  return ''
}
