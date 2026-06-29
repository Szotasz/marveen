// Post-respawn channel-plugin unlock for in-process tmux respawn-pane paths.
//
// scripts/channels.sh already runs an unlock probe after launching the main
// session (see PR #231 / #232): wait for the bun-poller, and if it never
// appears, the plugin is stuck in a Failed/disabled state and a manual
// /mcp + Up + Enter + Enter sequence is the only known revive. That helper
// covers cold launches (launchd start, manual `launchctl kickstart`).
//
// What it does NOT cover: the in-process respawn-pane recovery paths in
// channel-monitor.ts (resumeMarveenSession and respawnMarveenSessionFresh).
// Those call `tmux respawn-pane` directly with the claude command, completely
// bypassing channels.sh - so the post-init unlock never runs. The
// 2026-06-01 18:55 incident demonstrated this end-to-end: the keep-alive
// staleness watchdog fired respawnMarveenSessionFresh at 18:55:09, the new
// session came up cleanly, but the Telegram plugin landed in `◯ disabled`
// (likely a side-effect of a prior unlock-while-already-running cycle
// disabling it) and stayed there because no unlock probe was scheduled.
// The channel was offline for ~6 minutes until manually rescued via /mcp.
//
// This module is the in-process equivalent of the channels.sh probe.
// schedulePluginUnlockAfterRespawn() is fire-and-forget from the JS respawn
// paths; it waits past the cold-start window, gates on `pgrep -P <claude_pid>
// bun` (no bun = plugin is not running), and if it needs to act, sends the
// same /mcp + Up + Enter + Enter sequence. The Up wraps to the bottom of the
// MCP server list (where plugin:<provider>:<provider> lives), the first Enter
// opens its action menu, and the second Enter selects whichever first action
// is offered - "Enable" for disabled, "Reconnect" for failed. Both revive
// the plugin; the only failure mode (selecting "View tools" or "Disable" on
// a healthy plugin) is precluded by the bun-absence gate.
//
// Same caveat as channels.sh: while the keystrokes are being delivered the
// session cannot accept other input, but the helper runs in a setTimeout off
// the recovery thread and only fires once per respawn, so the cost is bounded.

import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import type { ChannelProviderType } from '../channel-provider.js'

const TMUX = resolveFromPath('tmux')

// Mirror of scripts/channels.sh post-init grace. The plugin handshake
// (bun spawn + Telegram getMe + sendMessage) usually completes within 15s
// of the claude TUI being interactive. After scheduleIdentitySetup's
// 8s modal-dismiss + 5s /name + a ~1s safety buffer, the prompt is ready
// around T+15s. We wait another 20s on top of that so a healthy plugin
// has time to write its bot.pid and spawn the bun child before we read.
// Total: T+35s post-respawn.
const UNLOCK_PROBE_DELAY_MS = 35_000

// If the bun child still hasn't appeared the first time we look, give it
// one more grace window before we conclude the plugin is wedged. Some
// installs see the bun process appear only after the first inbound poll,
// which can be delayed if Telegram's long-poll happens to be quiet.
const UNLOCK_PROBE_RETRY_DELAY_MS = 15_000
const UNLOCK_PROBE_MAX_RETRIES = 2

// Per-keystroke settling delays. Match the channels.sh script: opening /mcp
// renders the server list (~3s), Up scrolls to the bottom of the list (~1s),
// the first Enter opens the menu (~2s), the second Enter activates it (~3s).
const MCP_OPEN_SETTLE_MS = 3000
const KEYSTROKE_SETTLE_MS = 1500
// After the second Enter activates Enable/Reconnect, the plugin handshake
// takes a moment and Claude Code renders an action confirmation toast.
// Wait long enough for the toast to settle before Escape, otherwise the
// first Escape can be swallowed by the toast dismiss instead of backing
// out of the action menu.
const POST_UNLOCK_SETTLE_MS = 3000

function getSessionClaudePid(session: string): number | null {
  try {
    const raw = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim().split('\n')[0]
    const pid = parseInt(raw ?? '', 10)
    return Number.isFinite(pid) && pid > 1 ? pid : null
  } catch (err) {
    logger.warn({ err, session }, 'channel-plugin-unlock: failed to read session claude pid')
    return null
  }
}

// True iff at least one `bun` child is reparented under the claude pid -
// the plugin spawns its poller as a direct subprocess of the claude main
// loop, so bun's presence under the claude pid is the most reliable
// liveness signal we have. Matches the channels.sh `pgrep -P <claude_pid>
// bun` check so the two paths agree on what "plugin running" means.
function hasBunChild(claudePid: number): boolean {
  try {
    const out = execFileSync('/usr/bin/pgrep', ['-P', String(claudePid), 'bun'], {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim()
    return out.length > 0
  } catch {
    // pgrep exits 1 when there are no matches; treat as "no bun child"
    return false
  }
}

// Captured pane lines we use to refuse the keystrokes. Two safety gates:
// (a) the session must be at the bypass-permissions footer (the TUI's idle
// state). If we still see the modal/dialog prompt or the Resume-from-summary
// screen, the unlock keystrokes would land in the wrong context. (b) we
// never send keystrokes if `bun` *is* running - that would risk toggling
// the plugin into Disable, exactly the 2026-06-01 18:55 root cause.
function isSessionReadyForUnlock(session: string): boolean {
  try {
    const pane = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], {
      timeout: 3000,
      encoding: 'utf-8',
    })
    // Idle footer: claude renders this footer line once the TUI is ready
    // for input. Matches the empirical signature used by detectPaneState
    // for the 'idle' state.
    if (!/bypass permissions on/.test(pane)) return false
    // Refuse if any modal is visible.
    if (/Resume from summary/.test(pane)) return false
    if (/Open System Settings/.test(pane)) return false
    return true
  } catch (err) {
    logger.warn({ err, session }, 'channel-plugin-unlock: capture-pane failed')
    return false
  }
}

function sendUnlockKeystrokes(session: string, provider: ChannelProviderType): void {
  try {
    // Open the MCP dialog. Claude renders the server list within ~2s; the
    // 3s settle ensures the cursor is on the first item before we move.
    execFileSync(TMUX, ['send-keys', '-t', session, '/mcp', 'Enter'], { timeout: 5000 })
    execFileSync('/bin/sleep', [String(MCP_OPEN_SETTLE_MS / 1000)], { timeout: MCP_OPEN_SETTLE_MS + 2000 })

    // Safety gate: check whether the channel plugin appears in the /mcp list
    // before navigating to it. When the CC regression prevents the plugin from
    // loading at all, the list only shows google-workspace / spotify / computer-use
    // -- the Up key would select the wrong entry and Enable/Reconnect an unrelated
    // MCP server. If the provider slug is absent, bail out with Escape.
    let paneAfterOpen = ''
    try {
      paneAfterOpen = execFileSync(TMUX, ['capture-pane', '-t', session, '-p'], {
        timeout: 3000,
        encoding: 'utf-8',
      })
    } catch (err) {
      logger.warn({ err, session }, 'channel-plugin-unlock: capture-pane after /mcp open failed -- aborting')
      try { execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 5000 }) } catch { /* ignore */ }
      return
    }
    if (!paneAfterOpen.includes(provider)) {
      // Plugin is not in the MCP list (never loaded, not Failed/disabled) --
      // the unlock sequence cannot help and would target the wrong entry.
      logger.warn({ session, provider }, 'channel-plugin-unlock: provider plugin absent from /mcp list -- skipping unlock (plugin never loaded, not recoverable via /mcp)')
      try { execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 5000 }) } catch { /* ignore */ }
      return
    }

    // Up wraps to the bottom of the list, where the plugin servers live
    // (claude lists them last). Built-in MCPs are above Plugin MCPs in the
    // sort order, so the bottommost entry is the channel plugin we want.
    execFileSync(TMUX, ['send-keys', '-t', session, 'Up'], { timeout: 5000 })
    execFileSync('/bin/sleep', [String(KEYSTROKE_SETTLE_MS / 1000)], { timeout: KEYSTROKE_SETTLE_MS + 2000 })
    // First Enter opens the action menu for the selected MCP server.
    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    execFileSync('/bin/sleep', [String(KEYSTROKE_SETTLE_MS / 1000)], { timeout: KEYSTROKE_SETTLE_MS + 2000 })
    // Second Enter activates the first action - "Enable" for disabled,
    // "Reconnect" for failed. Both revive the plugin.
    execFileSync(TMUX, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    // After activation, the pane stays in the MCP server list (Claude Code
    // does NOT auto-dismiss to the prompt). detectPaneState reads that as
    // non-idle, every scheduled tick + inter-agent msg piles up with
    // "Schedule target session busy" until someone manually presses Esc.
    // 2026-06-01 19:25 incident: the unlock probe recovered the plugin at
    // 19:27:16, but the pane stayed wedged in the MCP list until manual
    // Escape at 19:40 -- 13 minutes of dropped traffic. Escape twice to
    // back out of both menu levels (action menu -> server list -> idle
    // prompt), with a settle between so the first Escape lands before
    // the second arrives.
    execFileSync('/bin/sleep', [String(POST_UNLOCK_SETTLE_MS / 1000)], { timeout: POST_UNLOCK_SETTLE_MS + 2000 })
    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 5000 })
    execFileSync('/bin/sleep', [String(KEYSTROKE_SETTLE_MS / 1000)], { timeout: KEYSTROKE_SETTLE_MS + 2000 })
    execFileSync(TMUX, ['send-keys', '-t', session, 'Escape'], { timeout: 5000 })
    logger.warn({ session }, 'channel-plugin-unlock: sent /mcp+Up+Enter+Enter+Esc+Esc unlock sequence')
  } catch (err) {
    logger.error({ err, session }, 'channel-plugin-unlock: failed to deliver unlock keystrokes')
  }
}

interface UnlockProbeState {
  session: string
  provider: ChannelProviderType
  retriesLeft: number
}

function runUnlockProbe(state: UnlockProbeState): void {
  const claudePid = getSessionClaudePid(state.session)
  if (!claudePid) {
    logger.warn({ session: state.session }, 'channel-plugin-unlock: no claude pid; skipping unlock probe')
    return
  }

  if (hasBunChild(claudePid)) {
    logger.info(
      { session: state.session, claudePid, provider: state.provider },
      'channel-plugin-unlock: bun child present, plugin healthy - no unlock needed',
    )
    return
  }

  if (!isSessionReadyForUnlock(state.session)) {
    if (state.retriesLeft > 0) {
      logger.info(
        { session: state.session, retriesLeft: state.retriesLeft },
        'channel-plugin-unlock: pane not idle yet, retrying',
      )
      setTimeout(() => runUnlockProbe({ ...state, retriesLeft: state.retriesLeft - 1 }), UNLOCK_PROBE_RETRY_DELAY_MS)
      return
    }
    logger.warn({ session: state.session }, 'channel-plugin-unlock: pane never reached idle state, abandoning')
    return
  }

  logger.warn(
    { session: state.session, claudePid, provider: state.provider },
    'channel-plugin-unlock: bun child absent after cold-start window, firing /mcp unlock sequence',
  )
  sendUnlockKeystrokes(state.session, state.provider)
}

/**
 * Schedule a post-respawn unlock probe for the main channels session.
 *
 * Call this fire-and-forget right after `tmux respawn-pane` in any in-process
 * recovery path (resumeMarveenSession, respawnMarveenSessionFresh, etc.).
 * The probe waits for the new claude session to finish cold-starting, then
 * checks `pgrep -P <claude_pid> bun`:
 *   - bun child present: plugin healthy, do nothing.
 *   - bun child absent + idle pane: send /mcp + Up + Enter + Enter to
 *     enable or reconnect whichever channel plugin is at the bottom of
 *     the MCP list.
 *   - bun child absent + non-idle pane: retry up to UNLOCK_PROBE_MAX_RETRIES
 *     times every UNLOCK_PROBE_RETRY_DELAY_MS before giving up.
 *
 * Idempotent across multiple respawns - each call schedules its own setTimeout
 * and the unlock-keystrokes path is itself gated on bun absence, so a stale
 * probe from a previous respawn cannot toggle a healthy plugin to Disable.
 */
export function schedulePluginUnlockAfterRespawn(session: string, provider: ChannelProviderType): void {
  setTimeout(
    () => runUnlockProbe({ session, provider, retriesLeft: UNLOCK_PROBE_MAX_RETRIES }),
    UNLOCK_PROBE_DELAY_MS,
  )
  logger.info(
    { session, provider, delayMs: UNLOCK_PROBE_DELAY_MS },
    'channel-plugin-unlock: probe scheduled after respawn',
  )
}
