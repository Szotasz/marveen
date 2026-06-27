import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../config.js'
import { readAgentChannelProvider } from './agent-config.js'
import { agentSessionName, capturePane } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { getProvider, type ChannelProviderType } from '../channel-provider.js'
import { paneLooksIdle, detectPaneState } from '../pane-state.js'

const TMUX = resolveFromPath('tmux')
const MAX_UP_ATTEMPTS = 8

/**
 * Fully dismiss the /mcp modal before returning.
 *
 * The /mcp menu is TWO levels deep (plugin LIST -> per-plugin action submenu).
 * A single Escape from inside the submenu only pops back to the LIST -- the
 * modal stays open. A reconnect that bails mid-navigation (e.g. "could not
 * place cursor on target option") then leaves the session parked in /mcp:
 * detectPaneState reads 'unknown', the scheduler skips it, and the session
 * goes deaf for up to an hour until the separate blocking-menu safety net
 * (Escape + respawn) fires. Root cause of the 2026-06-17 ~06:14 incident where
 * duolingo-esti-ellenorzes / kanban-audit / dream-engine waited 60+ min.
 *
 * Press Escape until the pane is confirmed back at the idle prompt (bounded).
 * We assert the POSITIVE idle state (paneLooksIdle) rather than the negative
 * "no blocking menu" (!detectsBlockingMenu): the incident failure mode is the
 * pane parked in the 'unknown' state, and 'unknown' is NOT a blocking menu, so a
 * negative check would return success while the pane is in exactly the deaf-
 * causing state. paneLooksIdle returns only when the input box is live and empty.
 * Extra Escapes at the normal prompt are harmless no-ops, so over-pressing is safe.
 */
function dismissMcpMenu(session: string): void {
  for (let i = 0; i < 4; i++) {
    try {
      execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.4'], { timeout: 1000 })
    } catch {
      return
    }
    const pane = capturePane(session) ?? ''
    if (pane && paneLooksIdle(pane)) return
  }
  // Budget exhausted without confirming idle: the modal may still be open (the
  // exact deaf-but-alive condition). Log loudly so the separate blocking-menu
  // safety net / operator can intervene instead of failing silently.
  const pane = capturePane(session) ?? ''
  if (!pane || !paneLooksIdle(pane)) {
    logger.warn({ session }, 'channel-mcp-reconnect: pane NOT confirmed idle after dismissMcpMenu escapes -- possible stuck /mcp modal')
  }
}

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
// Plugin-state markers Claude Code renders in the submenu header line
// `Status: <glyph> <word>`. We use the STATUS as authoritative when present,
// because scanning the whole pane for "reconnect"/"enable" is fragile in two
// ways: (a) Claude Code's own footer line ("Use /mcp to reconnect") triggers
// a false RECONNECT match even for disabled plugins; (b) action labels can
// change order across CC versions. Status text is rendered once, plugin-
// header-line, and is the ground truth for what action menu is offered.
//   ✔ connected -> View tools / Reconnect / Disable
//   ✗ failed    -> Reconnect / ...
//   ◯ disabled  -> Enable
// The ◯ vs ○ ambiguity is real (Claude Code has shipped both); match either.
const DISABLED_STATUS_RX = /Status:\s*[◯○]\s*disabled/i
const FAILED_STATUS_RX = /Status:\s*[✗x×]\s*failed/i
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
 * offers. Authoritative source is the `Status: <glyph> <word>` header that
 * Claude Code renders for every plugin in the submenu -- because scanning
 * for the option labels themselves false-positives on CC's own footer text
 * ("Use /mcp to reconnect", etc.) and pulled stage-1 onto Reconnect even
 * for disabled plugins (2026-06-01 20:02 incident: "could not place cursor
 * on target option ... target: reconnect" while the plugin was actually
 * `◯ disabled` and only an Enable row existed).
 *
 *   ◯ disabled -> Enable
 *   ✗ failed   -> Reconnect
 *   ✔ connected -> Reconnect (View tools is safe, Disable is forbidden)
 *
 * Returns null when neither status nor option label is found -- in that
 * case we must NOT press anything, because the remaining option could be
 * "Disable".
 */
export function chooseSubmenuTarget(pane: string): RegExp | null {
  // Status-first: ground truth, immune to footer false-positives.
  if (DISABLED_STATUS_RX.test(pane)) return ENABLE_RX
  if (FAILED_STATUS_RX.test(pane)) return RECONNECT_RX
  // Fallback: status header absent (older CC versions or partial captures).
  // Prefer Reconnect -- if the plugin were truly disabled it would not
  // expose a Reconnect row, so seeing one means we are NOT disabled.
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

  // Idle-guard: NEVER drive the /mcp menu (which starts by pressing Escape and
  // then navigates Up/Enter/Down) into a pane that is actively generating. The
  // Escape would interrupt the agent's in-flight turn and the navigation keys
  // would inject stray input into a live session -- i.e. it kills work in
  // progress. A 'busy' read means an Escape lands as an interrupt, so we defer
  // and let the caller retry on a later tick when the pane is back at the idle
  // prompt. (detectPaneState reads the live footer / busy indicators; scrollback
  // mentions of "esc to interrupt" are footer-scoped so they don't false-trip.)
  const preflight = capturePane(session) ?? ''
  if (detectPaneState(preflight) === 'busy') {
    logger.info({ agentName, session }, 'channel-mcp-reconnect: pane busy -- deferring reconnect to avoid interrupting active work')
    return { ok: false, message: 'Pane busy -- reconnect deferred to avoid interrupting active work' }
  }

  try {
    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 2000 })

    execFileSync(TMUX, ['send-keys', '-t', session, '/mcp', 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['1'], { timeout: 3000 })

    const pane1 = capturePane(session)
    if (!pane1) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: capture failed after /mcp')
      dismissMcpMenu(session)
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
      dismissMcpMenu(session)
      return { ok: false, message: `Plugin not found within ${MAX_UP_ATTEMPTS} Up attempts` }
    }

    // Inside the plugin submenu now. Drive the cursor onto a safe action
    // ("Reconnect", or "Enable" when disabled) and only press Enter once it
    // is confirmed there -- never blindly, which previously hit "Disable".
    let submenu = capturePane(session)
    if (!submenu) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: capture failed in submenu')
      dismissMcpMenu(session)
      return { ok: false, message: 'Failed to capture submenu pane' }
    }

    const target = chooseSubmenuTarget(submenu)
    if (!target) {
      logger.warn({ agentName, session }, 'channel-mcp-reconnect: no Reconnect/Enable option in submenu')
      dismissMcpMenu(session)
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
      dismissMcpMenu(session)
      return { ok: false, message: `Could not select ${target.source} within ${SUBMENU_MAX_STEPS} steps` }
    }

    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
    execFileSync('/bin/sleep', ['2'], { timeout: 4000 })
    dismissMcpMenu(session)

    const action = target === RECONNECT_RX ? 'Reconnect' : 'Enable'
    logger.info({ agentName, session, matchedAt, action, provider: providerType }, 'channel-mcp-reconnect: completed')
    return { ok: true, message: `Activated ${action} via /mcp (Up x${matchedAt})` }
  } catch (err) {
    logger.warn({ err, agentName, session }, 'channel-mcp-reconnect failed')
    try { dismissMcpMenu(session) } catch { /* best effort */ }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
