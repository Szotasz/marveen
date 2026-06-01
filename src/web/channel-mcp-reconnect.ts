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
  const escaped = provider.pluginPaneId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped, 'i')
}

// Max Down presses we'll spend trying to land the cursor on the target
// option inside the plugin submenu.
const SUBMENU_MAX_STEPS = 6
const RECONNECT_RX = /reconnect/i
// Word-anchored so it never matches the "Disable" option (which we must
// never activate). "Disable" contains no "enable" substring anyway, but the
// boundary keeps intent explicit.
const ENABLE_RX = /\benable\b/i
// Claude Code's TUI marks the selected list row with a `❯` cursor (same glyph
// the input prompt uses -- see pane-state.ts). capture-pane -p strips colour,
// so this textual marker is our only selection signal.
const POINTER_RX = /❯/

/** The submenu row currently marked with the `❯` cursor, or null. */
export function selectedSubmenuLine(pane: string): string | null {
  for (const raw of pane.split('\n')) {
    if (POINTER_RX.test(raw)) return raw
  }
  return null
}

/**
 * Pick which action to drive in the plugin submenu based on what the pane
 * offers. Prefer "Reconnect"; if the plugin sits in the disabled state only
 * "Enable" is available. Returns null when neither is present -- in that case
 * we must NOT press anything, because the remaining option could be "Disable".
 */
export function chooseSubmenuTarget(pane: string): RegExp | null {
  if (RECONNECT_RX.test(pane)) return RECONNECT_RX
  if (ENABLE_RX.test(pane)) return ENABLE_RX
  return null
}

/**
 * Attempt to reconnect a channel MCP plugin by navigating the /mcp
 * menu in the agent's tmux session. Generalises the existing
 * softReconnectMarveen() logic to any agent.
 *
 * Sequence: Escape → /mcp Enter → Up×N until plugin found → Enter →
 * step the `❯` cursor onto "Reconnect" (or "Enable" when disabled),
 * verifying after each step → Enter → Escape.
 *
 * The submenu option order is STATE-DEPENDENT in Claude Code 2.1.x:
 *   connected: 1.View tools  2.Reconnect  3.Disable
 *   failed:    1.Reconnect   ...
 *   disabled:  1.Enable
 * The previous logic blindly pressed Down+Enter, assuming "Reconnect" was
 * always one row down -- true only while connected. In the failed state that
 * landed on "Disable" and DISABLED the plugin, which then offered only
 * "Enable" and broke every subsequent retry ("submenu not found"). We now
 * read the menu and only press Enter once the cursor is confirmed on a safe
 * target.
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

    // Inside the plugin submenu now. Drive the cursor onto a safe action
    // ("Reconnect", or "Enable" when disabled) and only press Enter once it
    // is confirmed there -- never blindly, which previously hit "Disable".
    let submenu = capturePane(session)
    if (!submenu) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: capture failed in submenu')
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: 'Failed to capture submenu pane' }
    }

    const target = chooseSubmenuTarget(submenu)
    if (!target) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: no Reconnect/Enable option in submenu')
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: 'No Reconnect/Enable option in submenu' }
    }

    let onTarget = false
    for (let step = 0; step <= SUBMENU_MAX_STEPS; step++) {
      const sel = selectedSubmenuLine(submenu)
      if (sel && target.test(sel)) {
        onTarget = true
        break
      }
      execFileSync(TMUX, ['send-keys', '-t', session, 'Down'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.3'], { timeout: 1000 })
      submenu = capturePane(session) ?? ''
    }

    if (!onTarget) {
      logger.warn(
        { agentName, session, target: target.source, maxSteps: SUBMENU_MAX_STEPS },
        'channel-mcp-reconnect: could not place cursor on target option',
      )
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      return { ok: false, message: `Could not select ${target.source} within ${SUBMENU_MAX_STEPS} steps` }
    }

    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })

    const action = target === RECONNECT_RX ? 'Reconnect' : 'Enable'
    logger.info({ agentName, session, matchedAt, action, provider: providerType }, 'channel-mcp-reconnect: completed')
    return { ok: true, message: `Activated ${action} via /mcp (Up x${matchedAt})` }
  } catch (err) {
    logger.warn({ err, agentName, session }, 'channel-mcp-reconnect failed')
    try { execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 }) } catch { /* best effort */ }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
