import { join } from 'node:path'
import { homedir } from 'node:os'
import { MAIN_AGENT_ID, SERVICE_ID } from '../config.js'

// The channels tmux session name for a given main-agent id. The main agent
// runs in a long-lived `${id}-channels` tmux session (managed by launchd /
// systemd via channels.sh), not the `agent-${name}` template that sub-agents
// use. Pure + parameterized so the derivation is provable for any id, not just
// the default.
export function channelsSessionName(mainAgentId: string): string {
  return `${mainAgentId}-channels`
}

// The launchd label (`com.<serviceId>.channels`) and plist path for the
// channels job. The OS service id is SEPARATE from the agent id: SERVICE_ID
// (derived by the installer from BRAND_NAME) names the service units, while
// MAIN_AGENT_ID names the tmux session inside. Pure + parameterized so the
// label derivation is testable for any brand.
export function channelsLaunchdLabel(serviceId: string): string {
  return `com.${serviceId}.channels`
}
export function channelsPlistPath(serviceId: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${channelsLaunchdLabel(serviceId)}.plist`)
}

// The main agent (Marveen) runs in a long-lived `${id}-channels` tmux
// session managed by launchd, not the `agent-${name}` template that
// sub-agents use. Anything that needs to address it has to use this name
// rather than agentSessionName().
export const MAIN_CHANNELS_SESSION = channelsSessionName(MAIN_AGENT_ID)

// The launchd plist that owns MAIN_CHANNELS_SESSION. Used by the recovery
// path (telegram plugin monitor) to bounce the channels session via
// launchctl when softer reconnect attempts fail. The label keys off SERVICE_ID
// (the value the installer wrote into the plist filename), which defaults to
// MAIN_AGENT_ID, so an install without SERVICE_ID in its .env targets the same
// plist as before.
export const MAIN_CHANNELS_PLIST = channelsPlistPath(SERVICE_ID)

// Whether an agent's process lifecycle (start/restart) must go through the
// channels-session helper (systemd/launchd via hardRestartMarveenChannels)
// rather than the `agent-<name>` tmux template that sub-agents use. True only
// for the main agent: it has no `agents/<name>` dir and no `agent-<name>`
// session, so the agent-process path would spawn a rogue duplicate session and
// fire `/remote-control` (which needs a full-scope login token the agent's
// inference-only OAuth token lacks). Sub-agents stay on the agent-process path.
export function isMainChannelsAgent(name: string): boolean {
  return name === MAIN_AGENT_ID
}
