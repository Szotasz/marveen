import { join } from 'node:path'
import { homedir } from 'node:os'
import { MAIN_AGENT_ID } from '../config.js'

// The main agent (Marveen) runs in a long-lived `${id}-channels` tmux
// session managed by launchd, not the `agent-${name}` template that
// sub-agents use. Anything that needs to address it has to use this name
// rather than agentSessionName().
export const MAIN_CHANNELS_SESSION = `${MAIN_AGENT_ID}-channels`

// The launchd plist that owns MAIN_CHANNELS_SESSION. Used by the recovery
// path (telegram plugin monitor) to bounce the channels session via
// launchctl when softer reconnect attempts fail.
export const MAIN_CHANNELS_PLIST = join(
  homedir(),
  'Library',
  'LaunchAgents',
  `com.${MAIN_AGENT_ID}.channels.plist`
)
