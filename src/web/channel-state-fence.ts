/**
 * Per-agent channel state fence (SLACKDMVESZT1006).
 *
 * A sub-agent launch strips every <PROVIDER>_STATE_DIR (CHANSTATEUNSET930) and
 * re-exports only its own provider's. A channel plugin the session loads for ANY
 * other reason -- a settings layer that enables it, a future CLI default -- then
 * starts with no state dir and falls back to the shared default
 * (~/.claude/channels/<provider>), which is where the MAIN agent's token lives.
 *
 * Measured 2026-10-06: the slack-channel plugin came up under two sub-agents
 * (geri, samu) through an enabledPlugins entry they inherited, found the main
 * agent's Slack token on that fallback, and opened two more Socket Mode
 * connections on the owner's app: 9 of 32 DMs never reached the main session.
 *
 * The fence points every provider the agent does NOT use at the agent's OWN
 * per-provider dir (agents/<name>/.claude/channels/<provider>). A stray plugin
 * then finds no token and opens nothing; the main agent's token is never on
 * its path. The providers the launch does use keep their real export.
 */
import { channelStateDir, channelStateDirEnvVar, type ChannelProviderType } from '../channel-provider.js'
import { CHANNEL_PLUGIN_IDS } from './plugin-ids.js'

const ALL_PROVIDERS = Object.keys(CHANNEL_PLUGIN_IDS) as ChannelProviderType[]

/** Shell exports (each ending in ' && ') for every provider not in `exported`. */
export function buildChannelStateFence(exported: readonly ChannelProviderType[], agentDirPath: string): string {
  return ALL_PROVIDERS
    .filter(p => !exported.includes(p))
    .map(p => `export ${channelStateDirEnvVar(p)}="${channelStateDir(p, agentDirPath)}" && `)
    .join('')
}
