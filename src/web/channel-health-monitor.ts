import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames } from './agent-config.js'
import { isAgentRunning, capturePane } from './agent-process.js'
import {
  resolveAgentSession,
  resolveAgentProviderType,
} from './channel-mcp-reconnect.js'
import { getProvider } from '../channel-provider.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

// The MCP reconnect (attemptChannelMcpReconnect) is deliberately synchronous --
// it drives the interactive /mcp tmux menu with execFileSync('/bin/sleep', ...)
// pacing. Calling it INLINE from this 60s timer BLOCKS the libuv event loop for
// the full tmux+sleep duration; with several agents stuck in '✘ failed' the loop
// is starved continuously and the dashboard accepts TCP but never services HTTP
// (observed 2026-06-30: deaf for hours, 0% CPU, wedged in SyncProcessRunner under
// uv__run_timers). So run it in a DETACHED child (reconnect-cli.js) -- the
// blocking work happens off the main event loop. One in-flight reconnect per
// agent (the child clears the flag on exit).
const RECONNECT_CLI = fileURLToPath(new URL('./reconnect-cli.js', import.meta.url))
const inFlightReconnects = new Set<string>()

function spawnDetachedReconnect(agentName: string): boolean {
  if (inFlightReconnects.has(agentName)) return false
  inFlightReconnects.add(agentName)
  try {
    const child = spawn(process.execPath, [RECONNECT_CLI, agentName], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.once('exit', () => inFlightReconnects.delete(agentName))
    child.once('error', (err) => {
      inFlightReconnects.delete(agentName)
      logger.warn({ agentName, err }, 'channel-health-monitor: failed to spawn reconnect worker')
    })
    child.unref()
    return true
  } catch (err) {
    inFlightReconnects.delete(agentName)
    logger.warn({ agentName, err }, 'channel-health-monitor: reconnect spawn threw')
    return false
  }
}

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

function isPluginFailedInPane(pane: string, pluginPaneId: string): boolean {
  if (!pane.includes(pluginPaneId)) return false
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

  if (!isPluginFailedInPane(pane, provider.pluginPaneId)) {
    if (state) {
      logger.info({ agentName, provider: providerType }, 'channel-health-monitor: plugin recovered')
      reconnectState.delete(agentName)
    }
    return
  }

  const attempt = state ? state.attempts : 0
  // A detached reconnect for this agent may still be running from a prior tick;
  // don't pile on (the blocking /mcp walk can outlast one 60s tick).
  if (inFlightReconnects.has(agentName)) {
    logger.debug({ agentName, attempt }, 'channel-health-monitor: reconnect already in flight, skipping')
    return
  }
  logger.warn(
    { agentName, attempt, provider: providerType },
    'channel-health-monitor: plugin failure detected, spawning detached reconnect',
  )

  // Off-main-loop: the outcome is logged by reconnect-cli itself; here we only
  // record that we attempted, for backoff. Spawn-failure keeps the old backoff.
  spawnDetachedReconnect(agentName)

  const backoffMs = getBackoffMs(attempt)
  reconnectState.set(agentName, {
    attempts: attempt + 1,
    lastAttemptAt: now,
    nextRetryAt: now + backoffMs,
  })
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
