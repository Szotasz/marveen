import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../config.js'
import { readAgentChannelProvider } from './agent-config.js'
import { agentSessionName, capturePane } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { getProvider, type ChannelProviderType } from '../channel-provider.js'

const TMUX = resolveFromPath('tmux')
const MAX_UP_ATTEMPTS = 8

export interface ReconnectResult {
  ok: boolean
  message: string
}

export function resolveAgentSession(agentName: string): string {
  if (agentName === MAIN_AGENT_ID) return MAIN_CHANNELS_SESSION
  return agentSessionName(agentName)
}

export function resolveAgentProviderType(agentName: string): ChannelProviderType {
  const perAgent = readAgentChannelProvider(agentName)
  if (perAgent === 'slack' || perAgent === 'telegram') return perAgent
  return CHANNEL_PROVIDER
}

function getPluginPattern(providerType: ChannelProviderType): RegExp {
  const provider = getProvider(providerType)
  const escaped = provider.pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, 'i')
}

/**
 * Attempt to reconnect a channel MCP plugin by navigating the /mcp
 * menu in the agent's tmux session. Generalises the existing
 * softReconnectMarveen() logic to any agent.
 *
 * Sequence: Escape → /mcp Enter → Up×N until plugin found → Enter →
 * Down (Reconnect) → Enter → Escape.
 */
export function attemptChannelMcpReconnect(agentName: string): ReconnectResult {
  const session = resolveAgentSession(agentName)
  const providerType = resolveAgentProviderType(agentName)
  const pluginPattern = getPluginPattern(providerType)

  try {
    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 2000 })

    execFileSync(TMUX, ['send-keys', '-t', session, '/mcp', 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 3000 })

    const pane1 = capturePane(session)
    if (!pane1) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: capture failed after /mcp')
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: 'Failed to capture pane after /mcp' }
    }

    let matchedAt = -1
    for (let upCount = 1; upCount <= MAX_UP_ATTEMPTS; upCount++) {
      execFileSync(TMUX, ['send-keys', '-t', session, 'Up'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.2'], { timeout: 1000 })
      execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['1'], { timeout: 3000 })

      const pane = capturePane(session)
      if (pane && pluginPattern.test(pane)) {
        matchedAt = upCount
        break
      }
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.5'], { timeout: 1000 })
    }

    if (matchedAt < 0) {
      logger.warn(
        { agentName, session, maxUpAttempts: MAX_UP_ATTEMPTS, pluginPattern: pluginPattern.source },
        'channel-mcp-reconnect: plugin submenu not found',
      )
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: `Plugin not found within ${MAX_UP_ATTEMPTS} Up attempts` }
    }

    execFileSync(TMUX, ['send-keys', '-t', session, 'Down'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['0.3'], { timeout: 1000 })
    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['2'], { timeout: 4000 })

    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
    logger.info({ agentName, session, matchedAt, provider: providerType }, 'channel-mcp-reconnect: completed')
    return { ok: true, message: `Reconnected via /mcp (Up x${matchedAt})` }
  } catch (err) {
    logger.warn({ err, agentName, session }, 'channel-mcp-reconnect failed')
    try { execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 }) } catch { /* best effort */ }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
