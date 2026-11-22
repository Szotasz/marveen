import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { MAIN_AGENT_ID, SERVICE_ID } from '../config.js'
import { deployment, type Deployment } from './deployment.js'

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

// The command an operator runs to restart the channels unit by hand, for THIS
// install (#1878 item 6): the "restart failed" messages used to hardcode
// `systemctl --user restart marveen-channels`, wrong on a renamed install and
// with no macOS form. macOS: the launchd job in the GUI login's domain (run from
// a terminal of that login); Linux: the user unit. Docker (HOSTINGERLANGFU1122): there is no systemd or launchd in the
// container; supervisor runs channels.sh (docker/supervisord.conf, [program:channels]), and channels.sh kills the old
// session at its start, so a supervisor restart is a real restart. Run on the HOST: the container's hostname is its id.
export function channelsRestartCommand(
  platform: string = process.platform,
  serviceId: string = SERVICE_ID,
  deploy: Deployment = deployment(),
  host: string = hostname(),
): string {
  if (deploy === 'docker') {
    return `docker exec ${host} supervisorctl -c /opt/marveen-docker/supervisord.conf restart channels`
  }
  if (platform === 'darwin') {
    const label = channelsLaunchdLabel(serviceId)
    return `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist 2>/dev/null; launchctl kickstart -k gui/$(id -u)/${label}`
  }
  return `systemctl --user restart ${serviceId}-channels`
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

// Filter helper for endpoints that prepend the main agent separately and must
// not list it again as a worker entry (activity panel, model-suggest).
export function withoutMainAgent(names: string[]): string[] {
  return names.filter(n => !isMainChannelsAgent(n))
}
