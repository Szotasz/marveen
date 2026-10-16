/**
 * Per-agent co-listen channels (AGENTEXTRACH1006).
 *
 * The main agent can serve several providers from one session through
 * CHANNEL_PLUGINS_EXTRA (scripts/channels.sh). A sub-agent could not: its launch
 * read exactly one provider (resolveAgentProvider), and the channel-setup route
 * REWRITES channelProvider, so connecting Slack to a Telegram agent silently
 * replaced Telegram. This module is the sub-agent counterpart: an optional
 * agent-config field `extraChannels: ["slack"]` adds providers next to the
 * primary one, each with its own state dir, token and plugin.
 *
 * What the launch has to get right, and why each piece is here:
 *  - `--channels` must name EVERY plugin. A plugin that is loaded but not in the
 *    list delivers nothing ("server not in --channels list").
 *  - enabledPlugins must keep every one of them TRUE, in the agent's project
 *    settings AND in its isolated config dir. The scope step that stops a
 *    sub-agent fighting the main agent over a poller slot forces every
 *    non-primary channel plugin to false; the 2026-08-16 Discord co-listen
 *    outage was exactly that rewrite silencing the second bot on each restart
 *    (see readExtraChannelPluginIds in agent-process.ts).
 *  - each plugin finds its OWN state dir through its own <PROVIDER>_STATE_DIR
 *    export, so the extra provider's .env/access.json never touch the primary's.
 *
 * Fail-safe by construction: an extra provider without a token in its own
 * state dir contributes nothing, so a half-configured field cannot start a
 * plugin that would fall back to some other bot's token.
 */
import { join } from 'node:path'
import { CHANNEL_PLUGIN_IDS } from './plugin-ids.js'
import { channelStateDir, channelStateDirEnvVar, readChannelToken, type ChannelProviderType } from '../channel-provider.js'

const KNOWN_PROVIDERS = Object.keys(CHANNEL_PLUGIN_IDS) as ChannelProviderType[]

/**
 * Normalise a raw `extraChannels` value: known provider ids only, trimmed,
 * de-duplicated, order kept, and never the primary provider (a provider listed
 * twice would put the same plugin on --channels twice).
 */
export function parseExtraChannels(raw: unknown, primary: string | null): ChannelProviderType[] {
  if (!Array.isArray(raw)) return []
  const out: ChannelProviderType[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const p = v.trim() as ChannelProviderType
    if (!KNOWN_PROVIDERS.includes(p)) continue
    if (p === primary) continue
    if (!out.includes(p)) out.push(p)
  }
  return out
}

export interface ExtraChannelLaunch {
  /** Providers that actually take part in this launch (configured AND tokened). */
  providers: ChannelProviderType[]
  /** Providers configured but skipped because their state dir holds no token. */
  skipped: ChannelProviderType[]
  /** Marketplace plugin ids to keep enabled in every settings.json the launch reads. */
  pluginIds: string[]
  /** Appended to the --channels list: ` plugin:<id>` per provider, or ''. */
  channelArgs: string
  /** Shell exports for the extra plugins' state dirs, each ending in ' && ', or ''. */
  envExports: string
}

/**
 * Decide what the extra channels add to an agent launch. `primary` is the
 * agent's resolved provider; an extra equal to it is ignored. Token presence is
 * read through `hasToken` so the decision is testable without a filesystem.
 */
export function buildExtraChannelLaunch(
  extras: readonly ChannelProviderType[],
  primary: ChannelProviderType,
  agentDirPath: string,
  hasToken: (provider: ChannelProviderType, envPath: string) => boolean = (p, envPath) => !!readChannelToken(p, envPath),
): ExtraChannelLaunch {
  const providers: ChannelProviderType[] = []
  const skipped: ChannelProviderType[] = []
  for (const p of extras) {
    if (p === primary || providers.includes(p)) continue
    const dir = channelStateDir(p, agentDirPath)
    if (hasToken(p, join(dir, '.env'))) providers.push(p)
    else skipped.push(p)
  }
  const pluginIds = providers.map(p => CHANNEL_PLUGIN_IDS[p])
  const channelArgs = pluginIds.map(id => ` plugin:${id}`).join('')
  const envExports = providers.map(p => {
    const dir = channelStateDir(p, agentDirPath)
    const audit = p === 'slack' ? ` && export SLACK_AUDIT_LOG="${dir}/audit.jsonl"` : ''
    return `export ${channelStateDirEnvVar(p)}="${dir}"${audit} && `
  }).join('')
  return { providers, skipped, pluginIds, channelArgs, envExports }
}

/** Force the extra plugins on, after the primary-only scope step turned them off. */
export function enableExtraPlugins(
  enabledPlugins: Record<string, boolean>,
  pluginIds: readonly string[],
): Record<string, boolean> {
  const out = { ...enabledPlugins }
  for (const id of pluginIds) out[id] = true
  return out
}
