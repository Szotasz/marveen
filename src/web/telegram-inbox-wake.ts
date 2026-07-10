import { statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { resolveAgentChannelStateDir } from './voice-directive.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import {
  agentSessionName,
  isSessionReadyForPrompt,
  sendPromptToSession,
  sessionExistsOnHost,
} from './agent-process.js'

// --- sub-agent Telegram inbox wake-nudge --------------------------------------
// Extends the main-agent wake-nudge (message-router.ts) to the
// sub-agents. Sub-agents load the official channel plugin
// as a plain MCP server (per-agent mcp.json) to dodge the plugin in_use lock, so
// Claude Code drops that server's channel notifications. scripts/channel-inbound-
// tee.mjs persists each inbound to <state>/inbox-pending.jsonl, and the
// channel-inbox-drain.py UserPromptSubmit hook pulls it into the NEXT turn.
//
// The gap: the drain hook only fires when the agent takes a turn. An idle
// sub-agent (no user prompt, no --channels registration to start one) never
// drains, so a Telegram message can sit in inbox-pending.jsonl forever. This
// watcher closes that gap the same way the main agent's does: when a sub-agent's
// pending inbox has been stuck long enough AND its tmux session is idle, inject a
// minimal, CONTENT-FREE prompt so the drain hook fires and claims the backlog.
//
// The nudge carries NO content and does NOT touch the inbox file: the drain hook
// owns the atomic claim (rename) and the <channel> security framing (single
// source, no drift). This is the exact operation the scheduler already performs
// against sub-agent sessions for heartbeats (sendPromptToSession, idle-gated) --
// only the trigger differs, which is why the risk is low.

// How long the pending inbox must have sat untouched before the first wake-nudge.
// Measured as now - mtime(inbox-pending.jsonl): the age of the LAST inbound. A
// fresh file means a message just arrived (let the natural drain try first, or
// let a burst finish arriving before we nudge once for the whole batch).
const SUB_TELEGRAM_WAKE_MIN_AGE_MS = 25 * 1000
// Minimum gap between wake-nudges per agent. One nudge starts a turn whose drain
// claims the WHOLE pending file, so re-nudging sooner just piles redundant
// prompts on a session already handling its inbox.
const SUB_TELEGRAM_WAKE_DEBOUNCE_MS = 60 * 1000
// Content-free wake prompt. The channel-inbox-drain UserPromptSubmit hook
// PREPENDS the claimed (already security-framed) <channel> messages above this
// line, so the nudge is only a trailing trigger -- it must never carry inbound
// content itself.
const SUB_TELEGRAM_WAKE_NUDGE =
  '[telegram-wake] Bejövő Telegram üzenet(ek) várnak; a drain hook behúzta őket a kontextusba fentebb. Dolgozd fel és válaszolj.'

// Last wake-nudge timestamp per agent name (module-scoped debounce state).
const _lastSubWakeAt = new Map<string, number>()

/**
 * Pure decision: should the watcher send a wake-nudge to a sub-agent's session
 * for a stuck Telegram inbox? Dependency-free so it is unit-testable without
 * tmux or the filesystem, mirroring shouldWakeMainAgent. ALL conditions hold:
 *   - the inbox has pending content (nothing to drain otherwise);
 *   - it has sat untouched longer than minAgeMs (let a fresh arrival drain via a
 *     natural turn / let a burst settle first);
 *   - the debounce window since the last nudge for THIS agent has elapsed;
 *   - the session exists (nothing to wake otherwise);
 *   - it is idle (never inject a prompt mid-turn -- that is the race the main
 *     wake-nudge was designed to avoid).
 */
export function shouldWakeForTelegramInbox(params: {
  inboxAgeMs: number
  hasPending: boolean
  now: number
  lastWakeAt: number
  sessionExists: boolean
  sessionIdle: boolean
  minAgeMs: number
  debounceMs: number
}): boolean {
  const { inboxAgeMs, hasPending, now, lastWakeAt, sessionExists, sessionIdle, minAgeMs, debounceMs } = params
  if (!hasPending) return false
  if (inboxAgeMs <= minAgeMs) return false
  if (now - lastWakeAt < debounceMs) return false
  if (!sessionExists) return false
  if (!sessionIdle) return false
  return true
}

// I/O wrapper around shouldWakeForTelegramInbox: for each sub-agent, probes the
// pending-inbox file and (only when it looks stuck) the session's presence and
// idle state, then nudges. Called once per message-router tick.
//
// Cheap gates run FIRST so the common case (no stuck inbox) costs one statSync
// per agent and ZERO tmux I/O: isSessionReadyForPrompt does a blocking sleep +
// two capture-panes, so probing it for every agent every tick would pin the
// event loop. Only an agent with a genuinely stuck, out-of-debounce inbox pays
// for the session probe.
export function maybeWakeSubAgentsForTelegram(now: number): void {
  let names: string[]
  try {
    names = listAgentNames()
  } catch (err) {
    logger.warn({ err }, 'telegram-inbox-wake: listAgentNames failed')
    return
  }
  for (const name of names) {
    // The main agent runs with --channels and receives notifications natively;
    // it has no local derived inbox to drain.
    if (name === MAIN_AGENT_ID) continue
    try {
      const stateDir = resolveAgentChannelStateDir(name, 'telegram')
      const inboxPath = join(stateDir, 'inbox-pending.jsonl')
      let size: number
      let mtimeMs: number
      try {
        const st = statSync(inboxPath)
        size = st.size
        mtimeMs = st.mtimeMs
      } catch {
        continue // no inbox file -> nothing pending for this agent
      }
      if (size === 0) continue
      const inboxAgeMs = now - mtimeMs
      // Cheap gates before any tmux I/O (mirrors maybeWakeMainAgent).
      if (inboxAgeMs <= SUB_TELEGRAM_WAKE_MIN_AGE_MS) continue
      const lastWakeAt = _lastSubWakeAt.get(name) ?? 0
      if (now - lastWakeAt < SUB_TELEGRAM_WAKE_DEBOUNCE_MS) continue

      const host = readAgentRemoteHost(name)
      const session = agentSessionName(name)
      const sessionExists = sessionExistsOnHost(host, session)
      // isSessionReadyForPrompt already reports a widget-over-idle ('unknown')
      // pane as NOT ready, so a TodoWrite-widget session is conservatively left
      // alone rather than nudged mid-widget -- the safe default for injection.
      const sessionIdle = sessionExists && isSessionReadyForPrompt(session, host)

      if (!shouldWakeForTelegramInbox({
        inboxAgeMs,
        hasPending: true,
        now,
        lastWakeAt,
        sessionExists,
        sessionIdle,
        minAgeMs: SUB_TELEGRAM_WAKE_MIN_AGE_MS,
        debounceMs: SUB_TELEGRAM_WAKE_DEBOUNCE_MS,
      })) continue

      sendPromptToSession(session, SUB_TELEGRAM_WAKE_NUDGE, host)
      _lastSubWakeAt.set(name, now)
      logger.info({ agent: name, session, ageMs: Math.round(inboxAgeMs) }, 'telegram-inbox-wake: nudged idle sub-agent (pending inbox)')
    } catch (err) {
      logger.warn({ err, agent: name }, 'telegram-inbox-wake: wake check failed')
    }
  }
}

// Test-only: reset the per-agent debounce state between unit tests.
export function _resetSubWakeStateForTest(): void {
  _lastSubWakeAt.clear()
}
