import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane } from './agent-process.js'
import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
} from './channel-mcp-reconnect.js'
import { getProvider } from '../channel-provider.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

// Detect `plugin:X · ✘ failed` (or ✘ error / ✘ disconnected) in the
// pane output. Claude Code renders this in the MCP status area when a
// channel plugin connection drops.
const PLUGIN_FAILED_RX = /✘\s*(?:failed|error|disconnected)/i

interface AgentReconnectState {
  attempts: number
  lastAttemptAt: number
  nextRetryAt: number
}

const BACKOFF_BASE_MS = 30_000
const BACKOFF_MULTIPLIER = 3
const MAX_RETRIES = 3
const COOLDOWN_MS = 30 * 60 * 1000

const reconnectState = new Map<string, AgentReconnectState>()

function getBackoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt)
}

function isPluginFailedInPane(pane: string, pluginId: string): boolean {
  if (!pane.includes(pluginId)) return false
  return PLUGIN_FAILED_RX.test(pane)
}

export interface ChannelHealthStatus {
  healthy: boolean
  reconnectAttempts: number
  lastAttemptAt: number | null
}

export function getChannelHealth(agentName: string): ChannelHealthStatus {
  const state = reconnectState.get(agentName)
  if (!state) return { healthy: true, reconnectAttempts: 0, lastAttemptAt: null }
  return {
    healthy: false,
    reconnectAttempts: state.attempts,
    lastAttemptAt: state.lastAttemptAt,
  }
}

function checkAgent(agentName: string, session: string): void {
  const now = Date.now()
  const state = reconnectState.get(agentName)

  if (state && state.attempts >= MAX_RETRIES) {
    if (now - state.lastAttemptAt > COOLDOWN_MS) {
      reconnectState.delete(agentName)
    }
    return
  }

  if (state && now < state.nextRetryAt) return

  const pane = capturePane(session)
  if (!pane) return

  const providerType = resolveAgentProviderType(agentName)
  const provider = getProvider(providerType)

  if (!isPluginFailedInPane(pane, provider.pluginId)) {
    if (state) {
      logger.info({ agentName, provider: providerType }, 'channel-health-monitor: plugin recovered')
      reconnectState.delete(agentName)
    }
    return
  }

  const attempt = state ? state.attempts : 0
  logger.warn(
    { agentName, attempt, provider: providerType },
    'channel-health-monitor: plugin failure detected, attempting reconnect',
  )

  const result = attemptChannelMcpReconnect(agentName)

  const backoffMs = getBackoffMs(attempt)
  reconnectState.set(agentName, {
    attempts: attempt + 1,
    lastAttemptAt: now,
    nextRetryAt: now + backoffMs,
  })

  if (result.ok) {
    logger.info({ agentName, attempt }, 'channel-health-monitor: reconnect succeeded')
  } else {
    logger.warn(
      { agentName, attempt, message: result.message },
      'channel-health-monitor: reconnect failed',
    )
  }
}

export function startChannelHealthMonitor(): NodeJS.Timeout {
  function check() {
    try {
      checkAgent(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'channel-health-monitor: main agent check error')
    }

    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) continue
      try {
        checkAgent(name, resolveAgentSession(name))
      } catch (err) {
        logger.debug({ err, agent: name }, 'channel-health-monitor: agent check error')
      }
    }
  }

  // Offset from channel-monitor's 30s initial delay to avoid
  // overlapping tmux interactions on the same tick.
  setTimeout(check, 45_000)
  return setInterval(check, 60_000)
}
