// GROMZOMAINAGENT1106: the main agent on Gromzo, for the in-process launchers of the main session
// (channel-monitor respawns, the isolated main config). scripts/main-gromzo-launch.sh is the shell twin
// (channels.sh, channel-watchdog.sh, stuck-modal-guard.sh); a test runs both on the same inputs.
// The rules and why: see the header of the shell twin.
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GROMZO_PLUGIN_ID, MXD_AGENT_SOCK_DEFAULT, gromzoTokenExport, gromzoTokenFile, mxdAgentSockUsable } from './agent-extra-channels.js'

export const MAIN_GROMZO_PLUGIN_ID = GROMZO_PLUGIN_ID

const SLUG_RE = /^[a-z0-9-]{1,32}$/

/** The slug mxd knows the main agent by (default marveen, as src/config.ts), or null when it fails mxd's rule. */
export function mainGromzoSlug(mainAgentId: string | undefined | null): string | null {
  const s = mainAgentId === undefined || mainAgentId === null || mainAgentId === '' ? 'marveen' : mainAgentId
  return SLUG_RE.test(s) ? s : null
}

/** Whether the gromzo plugin may load for the main session: a valid slug and a usable agent.sock. */
export function mainGromzoUsable(mainAgentId: string | undefined | null, sockPath: string = MXD_AGENT_SOCK_DEFAULT): boolean {
  return mainGromzoSlug(mainAgentId) !== null && mxdAgentSockUsable(sockPath)
}

/** The ids, the gromzo id dropped when it may not load; every other id unchanged and in order. */
export function filterMainGromzoIds(mainAgentId: string | undefined | null, ids: string[], sockPath: string = MXD_AGENT_SOCK_DEFAULT): string[] {
  const usable = mainGromzoUsable(mainAgentId, sockPath)
  return ids.filter((id) => id !== '' && (id !== MAIN_GROMZO_PLUGIN_ID || usable))
}

/** The launch-command exports when the (filtered) ids carry the gromzo plugin, else ''. Never a settings file. */
export function mainGromzoEnv(mainAgentId: string | undefined | null, ids: string[], sockPath: string = MXD_AGENT_SOCK_DEFAULT): string {
  if (!ids.includes(MAIN_GROMZO_PLUGIN_ID)) return ''
  const slug = mainGromzoSlug(mainAgentId)
  // MXDAGENTSOCKID1106: the token path too, when mxd has a tokens dir (agent-extra-channels.ts gromzoTokenFile).
  return slug === null ? '' : `export MXD_AGENT="${slug}" && export MXD_SCOPE="both" && ${gromzoTokenExport(gromzoTokenFile(slug, sockPath))}`
}

/** GROMZOPLUGREG1109: the shared Claude Code plugin registry the dashboard writes the gromzo-local entries into
 *  (gromzo-marketplace.ts); read per call, so a test's HOME is honoured. */
export function mainGromzoPluginsFile(): string {
  return join(homedir(), '.claude', 'plugins', 'installed_plugins.json')
}

/** GROMZOPLUGREG1109: whether the Gromzo plugin is registered for Claude Code: its key in installed_plugins.json. The
 *  same plain substring test as the shell twin (main_gromzo_plugin_registered); an unreadable file is "no". */
export function mainGromzoPluginRegistered(pluginsFile: string = mainGromzoPluginsFile()): boolean {
  try {
    return readFileSync(pluginsFile, 'utf8').includes(`"${MAIN_GROMZO_PLUGIN_ID}"`)
  } catch {
    return false
  }
}

export type MainGromzoPendingReason = 'bad_slug' | 'mxd_socket' | 'not_enrolled' | 'plugin_not_registered'

/** GROMZOPLUGREG1109: the twin of main-gromzo-launch.sh main_gromzo_pending_reason: why the Gromzo plugin may NOT be the
 *  main agent's primary channel yet, or null when it may. In order: mxd's slug rule, a usable agent socket, the main
 *  agent enrolled (its token file exists, readable and not empty: mxd writes it only for an agent it runs, i.e. after
 *  the owner's consent), and the plugin registered for Claude Code (Samu 73877: measured on the QA VPS, an enrolled
 *  main agent with an unregistered plugin got --channels with no plugin server, and the down cascade restarted it). */
export function mainGromzoPendingReason(
  mainAgentId: string | undefined | null,
  sockPath: string = MXD_AGENT_SOCK_DEFAULT,
  pluginsFile: string = mainGromzoPluginsFile(),
): MainGromzoPendingReason | null {
  const slug = mainGromzoSlug(mainAgentId)
  if (!slug) return 'bad_slug'
  if (!mainGromzoUsable(mainAgentId, sockPath)) return 'mxd_socket'
  const tf = gromzoTokenFile(slug, sockPath)
  if (!tf) return 'not_enrolled'
  try {
    accessSync(tf, constants.R_OK)
    if (statSync(tf).size === 0) return 'not_enrolled'
  } catch {
    return 'not_enrolled'
  }
  return mainGromzoPluginRegistered(pluginsFile) ? null : 'plugin_not_registered'
}

/** GROMZONOPROVIDER1108: the twin of main-gromzo-launch.sh main_gromzo_primary_ready. The Gromzo plugin may be the
 *  main agent's PRIMARY channel (CHANNEL_PROVIDER=gromzo) only when nothing in mainGromzoPendingReason holds it back.
 *  Otherwise the main session is "gromzo pending": it runs without the Gromzo channel. */
export function mainGromzoPrimaryReady(
  mainAgentId: string | undefined | null,
  sockPath: string = MXD_AGENT_SOCK_DEFAULT,
  pluginsFile: string = mainGromzoPluginsFile(),
): boolean {
  return mainGromzoPendingReason(mainAgentId, sockPath, pluginsFile) === null
}
