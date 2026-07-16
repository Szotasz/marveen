import { statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, SUBAGENT_TELEGRAM_WAKE_ENABLED } from '../config.js'
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
// Claude Code drops that server's channel notifications. An inbound-tee persists
// each inbound to <state>/inbox-pending.jsonl, and a UserPromptSubmit drain hook
// pulls it into the NEXT turn.
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
//
// OPT-IN / DEFAULT-OFF: gated by SUBAGENT_TELEGRAM_WAKE_ENABLED. The inbound-tee
// writer and drain hook that produce/consume inbox-pending.jsonl ship in this
// repo but are themselves gated behind SUBAGENT_INBOX_TEE (default off), so with
// that path disabled there is no inbox file to wake on and this is a no-op
// regardless. Shipping it disabled means an upstream install pays zero per-tick
// cost and sees no behaviour change until BOTH flags are opted in.

// How long the pending inbox must have sat untouched before the first wake-nudge.
// Measured as now - mtime(inbox-pending.jsonl): the age of the LAST inbound. A
// fresh file means a message just arrived (let the natural drain try first, or
// let a burst finish arriving before we nudge once for the whole batch).
const SUB_TELEGRAM_WAKE_MIN_AGE_MS = 25 * 1000
// Base gap between wake-nudges per agent. One nudge starts a turn whose drain
// claims the WHOLE pending file, so re-nudging sooner just piles redundant
// prompts on a session already handling its inbox. This is the FIRST-retry gap;
// the effective gap grows exponentially with the per-agent attempt count (see
// backoff below).
const SUB_TELEGRAM_WAKE_DEBOUNCE_MS = 60 * 1000
// Backoff cap: the exponential gap never exceeds this, so a stuck session is
// probed at most ~twice an hour rather than every minute.
const SUB_TELEGRAM_WAKE_MAX_DEBOUNCE_MS = 30 * 60 * 1000
// Max wake-nudges spent on ONE stuck inbox before giving up. A session that
// never drains after this many nudges is not going to; further nudges just spam
// it every backoff window forever (the failure mode called out in review). The
// budget is per DISTINCT backlog: when a NEW inbound arrives (the inbox file's
// mtime advances) the attempt counter resets, so a genuinely new message always
// gets a fresh round of nudges.
const SUB_TELEGRAM_WAKE_MAX_ATTEMPTS = 5
// Content-free wake prompt. The channel-inbox-drain UserPromptSubmit hook
// PREPENDS the claimed (already security-framed) <channel> messages above this
// line, so the nudge is only a trailing trigger -- it must never carry inbound
// content itself.
const SUB_TELEGRAM_WAKE_NUDGE =
  '[telegram-wake] Bejövő Telegram üzenet(ek) várnak; a drain hook behúzta őket a kontextusba fentebb. Dolgozd fel és válaszolj.'

// Per-agent wake state (module-scoped). `attempts` counts nudges spent on the
// CURRENT stuck backlog; `inboxMtimeMs` is the mtime we last acted on, used to
// detect a fresh inbound (mtime advance) and reset the attempt budget.
interface SubWakeState {
  lastWakeAt: number
  attempts: number
  inboxMtimeMs: number
}
const _subWakeState = new Map<string, SubWakeState>()

/**
 * Compute the effective backoff gap for the Nth wake attempt: base * 2^attempts,
 * capped at maxMs. attempts=0 -> base (unchanged first-retry behaviour). Pure.
 */
export function wakeBackoffMs(attempts: number, baseMs: number, maxMs: number): number {
  const grown = baseMs * Math.pow(2, Math.max(0, attempts))
  return Math.min(grown, maxMs)
}

/**
 * Pure decision: should the watcher send a wake-nudge to a sub-agent's session
 * for a stuck Telegram inbox? Dependency-free so it is unit-testable without
 * tmux or the filesystem, mirroring shouldWakeMainAgent. ALL conditions hold:
 *   - the inbox has pending content (nothing to drain otherwise);
 *   - it has sat untouched longer than minAgeMs (let a fresh arrival drain via a
 *     natural turn / let a burst settle first);
 *   - the per-agent attempt budget is not yet exhausted (a never-draining session
 *     is not nudged forever -- it resumes only when a new inbound resets attempts);
 *   - the backoff window since the last nudge for THIS agent has elapsed (the gap
 *     grows exponentially with attempts);
 *   - the session exists (nothing to wake otherwise);
 *   - it is idle (never inject a prompt mid-turn -- that is the race the main
 *     wake-nudge was designed to avoid).
 *
 * `attempts`/`maxAttempts`/`maxDebounceMs` are optional and default to the
 * pre-backoff behaviour (attempts 0, no cap on tries, no debounce cap), so
 * existing callers/tests are unchanged.
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
  attempts?: number
  maxAttempts?: number
  maxDebounceMs?: number
}): boolean {
  const { inboxAgeMs, hasPending, now, lastWakeAt, sessionExists, sessionIdle, minAgeMs, debounceMs } = params
  const attempts = params.attempts ?? 0
  const maxAttempts = params.maxAttempts ?? Infinity
  const maxDebounceMs = params.maxDebounceMs ?? Infinity
  if (!hasPending) return false
  if (inboxAgeMs <= minAgeMs) return false
  if (attempts >= maxAttempts) return false // budget exhausted for this backlog
  if (now - lastWakeAt < wakeBackoffMs(attempts, debounceMs, maxDebounceMs)) return false
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
export async function maybeWakeSubAgentsForTelegram(now: number): Promise<void> {
  // OPT-IN gate (DEFAULT OFF). Cheapest possible early-out: when disabled the
  // whole watcher is a single boolean check per tick and touches no filesystem.
  if (!SUBAGENT_TELEGRAM_WAKE_ENABLED) return

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
        _subWakeState.delete(name) // no inbox file -> drop stale state, start fresh next time
        continue
      }
      if (size === 0) {
        _subWakeState.delete(name) // drained/empty -> reset the attempt budget
        continue
      }
      const inboxAgeMs = now - mtimeMs
      // Cheap gates before any tmux I/O (mirrors maybeWakeMainAgent).
      if (inboxAgeMs <= SUB_TELEGRAM_WAKE_MIN_AGE_MS) continue

      // Per-agent backoff state. A NEW inbound (the tee appended, so mtime
      // advanced past what we last acted on) is a distinct backlog: reset the
      // attempt budget so a fresh message always earns a fresh round of nudges.
      let state = _subWakeState.get(name)
      if (!state || state.inboxMtimeMs !== mtimeMs) {
        state = { lastWakeAt: state?.lastWakeAt ?? 0, attempts: 0, inboxMtimeMs: mtimeMs }
        _subWakeState.set(name, state)
      }
      // Budget + backoff cheap gates (no tmux I/O yet).
      if (state.attempts >= SUB_TELEGRAM_WAKE_MAX_ATTEMPTS) continue
      if (now - state.lastWakeAt < wakeBackoffMs(state.attempts, SUB_TELEGRAM_WAKE_DEBOUNCE_MS, SUB_TELEGRAM_WAKE_MAX_DEBOUNCE_MS)) continue

      const host = readAgentRemoteHost(name)
      const session = agentSessionName(name)
      const sessionExists = sessionExistsOnHost(host, session)
      // isSessionReadyForPrompt already reports a widget-over-idle ('unknown')
      // pane as NOT ready, so a TodoWrite-widget session is conservatively left
      // alone rather than nudged mid-widget -- the safe default for injection.
      const sessionIdle = sessionExists && await isSessionReadyForPrompt(session, host)

      if (!shouldWakeForTelegramInbox({
        inboxAgeMs,
        hasPending: true,
        now,
        lastWakeAt: state.lastWakeAt,
        sessionExists,
        sessionIdle,
        minAgeMs: SUB_TELEGRAM_WAKE_MIN_AGE_MS,
        debounceMs: SUB_TELEGRAM_WAKE_DEBOUNCE_MS,
        attempts: state.attempts,
        maxAttempts: SUB_TELEGRAM_WAKE_MAX_ATTEMPTS,
        maxDebounceMs: SUB_TELEGRAM_WAKE_MAX_DEBOUNCE_MS,
      })) continue

      sendPromptToSession(session, SUB_TELEGRAM_WAKE_NUDGE, host)
      state.lastWakeAt = now
      state.attempts += 1
      logger.info({ agent: name, session, ageMs: Math.round(inboxAgeMs), attempt: state.attempts }, 'telegram-inbox-wake: nudged idle sub-agent (pending inbox)')
    } catch (err) {
      logger.warn({ err, agent: name }, 'telegram-inbox-wake: wake check failed')
    }
  }
}

// Test-only: reset the per-agent wake state between unit tests.
export function _resetSubWakeStateForTest(): void {
  _subWakeState.clear()
}
