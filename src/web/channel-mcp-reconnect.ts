import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, CHANNEL_PROVIDER } from '../config.js'
import { readAgentChannelProvider } from './agent-config.js'
import { agentSessionName, capturePane, captureParkedInputView } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { getProvider, type ChannelProviderType } from '../channel-provider.js'
import { tryAcquireSessionSendLane } from './session-send-lock.js'
import {
  paneLooksIdle,
  detectPaneState,
  detectsBlockingMenu,
  idleConsideringDimGhost,
  parkedInputText,
} from '../pane-state.js'
import { exactTmuxTarget } from '../tmux-target.js'
import {
  classifyMcpInlineReply,
  countMcpCommandEchoes,
  isSafeMcpServerName,
  mcpCommandReply,
  mcpReplyIsLatest,
  showsMcpDialogTitle,
  type McpInlineAction,
  type McpInlineOutcome,
} from './mcp-inline-command.js'

const TMUX = resolveFromPath('tmux')

// A reconnect settles in a few seconds (busy spinner, "Reconnecting" panel,
// then the result line); poll once a second for up to this many seconds.
const TYPED_POLL_MAX = 10

/**
 * Dismiss the /mcp modal by pressing Escape until the pane is back at the idle
 * prompt (bounded to 4 presses).
 *
 * The /mcp menu is two levels deep (server list -> per-server submenu), so a
 * single Escape may only pop one level. We assert the POSITIVE idle state
 * (paneLooksIdle) rather than "no blocking menu": a pane parked in the
 * 'unknown' state is not a blocking menu, yet is exactly the deaf-causing
 * state, so a negative check would report success there.
 *
 * With stopWhenMenuClosed the loop is gate-safe: after each Escape it
 * re-captures and stops at once if the capture failed, the pane turned busy or
 * the blocking menu is gone. Further Escapes would clear text parked in the
 * revealed input box or interrupt a running turn.
 */
function dismissMcpMenu(session: string, opts: { stopWhenMenuClosed?: boolean } = {}): void {
  for (let i = 0; i < 4; i++) {
    try {
      execFileSync(TMUX, ['send-keys', '-t', exactTmuxTarget(session), 'Escape'], { timeout: 3000 })
      execFileSync('/bin/sleep', ['0.4'], { timeout: 1000 })
    } catch {
      return
    }
    const captured = capturePane(session)
    if (opts.stopWhenMenuClosed) {
      if (captured == null || detectPaneState(captured) === 'busy' || !detectsBlockingMenu(captured)) return
    }
    const pane = captured ?? ''
    if (pane && paneLooksIdle(pane)) return
  }
  // Budget exhausted without confirming idle: the modal may still be open (the
  // deaf-but-alive condition). Log loudly so the blocking-menu safety net or an
  // operator can intervene instead of failing silently.
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

/**
 * Redacted diagnostic signature of a captured pane for the failure warns.
 * Booleans/counts ONLY: the pane is a live session's screen and may contain
 * conversation content, which must never reach the log. The signature answers:
 * was a blocking menu open at all, was the plugin row rendered, and what state
 * the pane was in.
 */
export function paneDiagSignature(
  pane: string | null,
  pluginPattern: RegExp,
): Record<string, unknown> {
  if (pane == null) return { paneCaptured: false }
  return {
    paneCaptured: true,
    paneNonEmptyLines: pane.split('\n').filter((l) => l.trim().length > 0).length,
    inBlockingMenu: detectsBlockingMenu(pane),
    sawPluginRow: pluginPattern.test(pane),
    paneState: detectPaneState(pane),
  }
}

const REFUSE_UNREADABLE: ReconnectResult = { ok: false, message: 'Pane unreadable -- reconnect refused' }
const DEFER_BUSY: ReconnectResult = { ok: false, message: 'Pane busy -- reconnect deferred to avoid interrupting active work' }
const DEFER_PARKED: ReconnectResult = { ok: false, message: 'Input box not empty -- reconnect deferred' }

/** Idle prompt with an empty box; a dim placeholder in the box still counts as empty. */
function isIdle(session: string, pane: string): boolean {
  return idleConsideringDimGhost(pane, detectPaneState(pane) === 'typing' ? captureParkedInputView(session) : null)
}

/**
 * What a reply that never showed up reports, from a fresh capture: the /mcp
 * dialog opened instead of the command (see dialogOpenedResult), the typed
 * command still sits in the input box (touch nothing), or nothing was
 * observed. "Not observed" is ok:true only when it is unambiguous: an older
 * identical echo on screen before typing (ours may push it off screen, so the
 * count never grows) or a grown echo count whose reply could not be claimed as
 * ours (not the latest exchange) both make it ok:false.
 */
function unobservedResult(session: string, ambiguous: boolean): ReconnectResult {
  // Decide on a FRESH capture: the last poll can be seconds old.
  const pane = capturePane(session)
  if (pane == null) return { ok: false, message: 'Pane unreadable after the command -- outcome not observed' }
  if (detectsBlockingMenu(pane)) return dialogOpenedResult(session, pane)
  if ((parkedInputText(pane) ?? '').includes('/mcp')) {
    return { ok: false, message: 'Command left in the input box' }
  }
  if (ambiguous) {
    return { ok: false, message: 'Outcome not observed (an identical echo on screen could not be claimed as ours)' }
  }
  return { ok: true, message: 'Command sent; outcome not observed' }
}

/**
 * The /mcp dialog opened instead of the command. Escape only the /mcp dialog,
 * and only on a pane that is not busy: Escape on another modal (a tool
 * permission prompt, a consent dialog) would answer it, and on a busy pane it
 * would interrupt the turn.
 */
function dialogOpenedResult(session: string, pane: string): ReconnectResult {
  if (detectsBlockingMenu(pane) && showsMcpDialogTitle(pane) && detectPaneState(pane) !== 'busy') {
    dismissMcpMenu(session, { stopWhenMenuClosed: true })
  }
  return { ok: false, message: 'MCP dialog opened instead of the command' }
}

/**
 * Type `/mcp <action> <serverName>`, submit it and poll until ITS OWN reply is
 * on screen. The echo count must grow past the pre-typing baseline, so an older
 * identical echo and result still on screen are never taken for ours; the
 * reply is the block under the newest echo. Never presses Escape itself (only
 * unobservedResult may, through dismissMcpMenu).
 */
function typeMcpCommandAndWait(
  session: string,
  action: McpInlineAction,
  serverName: string,
): McpInlineOutcome | ReconnectResult {
  // Gate again right before the first key (this also covers the later steps of
  // the disabled path). The baseline must come from a readable, still-idle
  // pane: a null capture would count as zero echoes and let an older identical
  // reply pass as ours.
  const before = capturePane(session)
  if (before == null) return REFUSE_UNREADABLE
  if (detectPaneState(before) === 'busy') return DEFER_BUSY
  if (!isIdle(session, before)) return DEFER_PARKED
  const baseline = countMcpCommandEchoes(before, action, serverName)
  execFileSync(TMUX, ['send-keys', '-t', exactTmuxTarget(session), '-l', `/mcp ${action} ${serverName}`], { timeout: 3000 })
  execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 })
  execFileSync(TMUX, ['send-keys', '-t', exactTmuxTarget(session), 'Enter'], { timeout: 3000 })
  // A grown echo count whose reply could not be claimed (not rendered yet, or
  // not the latest exchange) makes a later timeout ambiguous, like an older
  // echo on screen does.
  let unclaimedEcho = false
  for (let i = 0; i < TYPED_POLL_MAX; i++) {
    execFileSync('/bin/sleep', ['1'], { timeout: 3000 })
    const pane = capturePane(session)
    if (pane == null) continue
    if (countMcpCommandEchoes(pane, action, serverName) <= baseline) continue
    unclaimedEcho = true
    const reply = mcpCommandReply(pane, action, serverName)
    if (reply == null) continue
    // An older identical echo that came into view is not ours: wait for ours.
    if (!mcpReplyIsLatest(pane, action, serverName)) continue
    const outcome = classifyMcpInlineReply(reply, action, serverName)
    if (outcome === 'dialog-open') return dialogOpenedResult(session, pane)
    // A reply of OURS is on screen but matches no known literal (CLI wording
    // drift, the exception branch's "Error: ..."): never read that as success.
    if (outcome === 'unknown') return { ok: false, message: `Unrecognised reply to /mcp ${action}` }
    return outcome
  }
  return unobservedResult(session, baseline > 0 || unclaimedEcho)
}

function isOutcome(r: McpInlineOutcome | ReconnectResult): r is McpInlineOutcome {
  return typeof r === 'string'
}

function reconnectResult(outcome: McpInlineOutcome, serverName: string): ReconnectResult {
  if (outcome === 'reconnected') return { ok: true, message: 'Reconnected via /mcp reconnect' }
  return { ok: false, message: `/mcp reconnect ${serverName}: ${outcome}` }
}

/**
 * Attempt to reconnect a channel MCP plugin by typing the one-line
 * `/mcp reconnect <server>` command into the agent's tmux session and reading
 * the CLI's reply (no menu navigation).
 *
 * Nothing is typed unless the pane is provably idle with an empty input box:
 * send-keys APPENDS to the input box and Enter submits whatever is parked
 * there. An open /mcp modal is dismissed first, but only on a pane that is not
 * busy, and the dismiss stops as soon as the menu is gone.
 *
 * Replies map as: reconnected -> ok; disabled -> `/mcp enable <server>` then
 * one more reconnect; any other recognised outcome -> ok:false naming it; an
 * unrecognised reply or timeout -> see unobservedResult.
 */
export function attemptChannelMcpReconnect(agentName: string): ReconnectResult {
  const session = resolveAgentSession(agentName)
  const providerType = resolveAgentProviderType(agentName)
  const pluginPattern = getPluginPattern(providerType)

  let pre = capturePane(session)
  if (pre == null) {
    logger.warn({ agentName, session }, 'channel-mcp-reconnect: capture failed before any keystroke -- refusing')
    return REFUSE_UNREADABLE
  }
  if (detectPaneState(pre) === 'busy') {
    logger.info({ agentName, session }, 'channel-mcp-reconnect: pane busy -- deferring reconnect to avoid interrupting active work')
    return { ok: false, message: 'Pane busy -- reconnect deferred to avoid interrupting active work' }
  }

  // The typed command is a direct write into a pane that also receives locked
  // deliveries. Take the pane's send lane fail-closed for the entire sequence:
  // a busy lane means a delivery is mid-chunk-stream and our keys would land
  // inside its framed text. Skip and let the caller's tick retry.
  const releaseLane = tryAcquireSessionSendLane(session, null)
  if (!releaseLane) {
    logger.info({ agentName, session }, 'channel-mcp-reconnect: pane send lane busy (delivery in flight) -- deferring reconnect (fail-closed)')
    return { ok: false, message: 'A delivery is in flight into this pane -- reconnect deferred' }
  }

  try {
    if (!isIdle(session, pre)) {
      if (detectsBlockingMenu(pre) && !showsMcpDialogTitle(pre)) {
        // Another modal (a tool permission prompt, a consent dialog): any key
        // would answer it. Touch nothing.
        logger.warn({ agentName, session, pane: paneDiagSignature(pre, pluginPattern) }, 'channel-mcp-reconnect: a dialog other than /mcp is open -- refusing')
        return { ok: false, message: 'A dialog other than /mcp is open -- reconnect refused' }
      }
      if (detectsBlockingMenu(pre)) {
        dismissMcpMenu(session, { stopWhenMenuClosed: true })
        pre = capturePane(session)
        if (pre == null) return REFUSE_UNREADABLE
        if (detectPaneState(pre) === 'busy') return DEFER_BUSY
        if (detectsBlockingMenu(pre)) {
          logger.warn({ agentName, session, pane: paneDiagSignature(pre, pluginPattern) }, 'channel-mcp-reconnect: menu still open after dismiss -- refusing')
          return { ok: false, message: 'MCP dialog still open -- reconnect refused' }
        }
        if (!isIdle(session, pre)) return DEFER_PARKED
      } else {
        logger.warn({ agentName, session, pane: paneDiagSignature(pre, pluginPattern) }, 'channel-mcp-reconnect: input box not empty -- reconnect deferred')
        return DEFER_PARKED
      }
    }

    const provider = getProvider(providerType)
    const serverName = provider.mcpServerName ?? provider.pluginPaneId
    if (!isSafeMcpServerName(serverName)) {
      logger.warn({ agentName, session, provider: providerType }, 'channel-mcp-reconnect: unsafe MCP server name -- nothing typed')
      return { ok: false, message: 'Unsafe MCP server name -- reconnect refused' }
    }

    const first = typeMcpCommandAndWait(session, 'reconnect', serverName)
    if (!isOutcome(first)) return first
    if (first !== 'disabled') {
      if (first !== 'reconnected') logger.warn({ agentName, session, outcome: first }, 'channel-mcp-reconnect: /mcp reconnect did not succeed')
      return reconnectResult(first, serverName)
    }

    // The server is disabled: enable it, then reconnect once more. Each typed
    // step re-gates the pane itself before its first key.
    const enable = typeMcpCommandAndWait(session, 'enable', serverName)
    if (!isOutcome(enable)) return enable
    if (enable === 'already-enabled') {
      return { ok: false, message: `/mcp enable ${serverName}: already enabled but reported disabled` }
    }
    if (enable !== 'enabled') return { ok: false, message: `/mcp enable ${serverName}: ${enable}` }
    const second = typeMcpCommandAndWait(session, 'reconnect', serverName)
    if (!isOutcome(second)) return second
    return reconnectResult(second, serverName)
  } catch (err) {
    logger.warn({ err, agentName, session }, 'channel-mcp-reconnect failed')
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  } finally {
    releaseLane()
  }
}
