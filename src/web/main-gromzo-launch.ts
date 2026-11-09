// GROMZOMAINAGENT1106: the main agent on Gromzo, for the in-process launchers of the main session
// (channel-monitor respawns, the isolated main config). scripts/main-gromzo-launch.sh is the shell twin
// (channels.sh, channel-watchdog.sh, stuck-modal-guard.sh); a test runs both on the same inputs.
// The rules and why: see the header of the shell twin.
import { accessSync, constants, statSync } from 'node:fs'
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

/** GROMZONOPROVIDER1108: the twin of main-gromzo-launch.sh main_gromzo_primary_ready. The Gromzo plugin may be the
 *  main agent's PRIMARY channel (CHANNEL_PROVIDER=gromzo) only when mxd's agent socket is usable AND the main agent is
 *  enrolled: its token file exists, readable and not empty (mxd writes it only for an agent it runs, i.e. after the
 *  owner's consent). Otherwise the main session is "gromzo pending": it runs without the Gromzo channel. */
export function mainGromzoPrimaryReady(mainAgentId: string | undefined | null, sockPath: string = MXD_AGENT_SOCK_DEFAULT): boolean {
  if (!mainGromzoUsable(mainAgentId, sockPath)) return false
  const slug = mainGromzoSlug(mainAgentId)
  if (!slug) return false
  const tf = gromzoTokenFile(slug, sockPath)
  if (!tf) return false
  try {
    accessSync(tf, constants.R_OK)
    return statSync(tf).size > 0
  } catch {
    return false
  }
}
