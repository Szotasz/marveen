// Inbox-nudge watcher: the "engine" behind the main agent's autonomous
// inter-agent (and federated) mail processing.
//
// The main agent's ONLY inbound delivery path is the UserPromptSubmit hook
// (scripts/hooks/inbox-drain.py -> POST /api/agents/<main>/drain-inbox): the
// message router deliberately skips the main agent (PULL model -- a past
// tmux-inject into the perpetually-busy channels session wedged delivery for
// ~1h). Consequence before this watcher: mail addressed to the main agent sat
// pending until a HUMAN happened to prompt it. This watcher closes that gap:
// when the main agent has pending inbox mail AND its channels session is
// GENUINELY idle, it types one tiny static nudge line into the session; the
// submit fires the drain hook, which claims and prepends the wrapped messages.
//
// Why this does NOT reintroduce the old race (adversarially reviewed):
//   - The nudge fires only on double-capture-confirmed idle
//     (isSessionReadyForPrompt) and the send itself ABORTS instead of
//     best-effort-typing when the pane turns busy in the gap
//     (sendPromptToSession onBusyTimeout:'abort') -- zero keystrokes reach a
//     busy pane.
//   - The nudge text is a SINGLE visual row (<=70 chars, unit-tested): the
//     headless channels pane is tmux-default 80 columns (channels.sh
//     new-session has no -x), and MAIN's only parked-plain-text recovery is
//     the stuck-input watcher's bare-Enter branch, which submits single-row
//     text but permanently HOLDS multi-row text (pane-state.ts
//     decideStuckInputAction default branch; clearStaleParkedInput never
//     touches MAIN). Single-row is the only self-recoverable shape.
//   - One nudge consumes the wall-clock-global debounce whether or not it
//     lands; a nudge that provably did not lead to a claim (same oldest id
//     still pending) escalates through a 5-min cooldown, then STOPS after
//     MAX_STALE_NUDGES and alerts the owner ONCE (broken drain hook / wedged
//     session -- infinite paid Claude turns against a broken hook would be
//     worse than the status quo).
//   - A rolling hourly budget caps autonomous turn generation even under a
//     steady message stream; budget exhaustion degrades to today's baseline
//     (the next human/scheduled prompt drains the inbox), never to loss.
//   - The channel plugin remains an independent in-process writer no idle
//     check can exclude; the residual overlap is one short static line whose
//     merged submit still just fires the drain hook (benign).
//
// The predicate is getPendingMessages(MAIN_AGENT_ID) -- to_agent = MAIN
// exactly. Queued OUTBOUND federated rows (to_agent 'peer/agent', pending up
// to the abandon window while a peer is down) never match, so a down peer
// cannot nudge the main agent about mail it cannot act on.
//
// Decision logic is pure (decideNudgePreflight/recordNudge) with a thin IO
// shell, mirroring decideStuckInputRecovery.
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { getPendingMessages } from '../db.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { isSessionReadyForPrompt, sendPromptToSession, sessionExistsOnHost } from './agent-process.js'
import { sendAlert } from './channel-monitor.js'

export const INBOX_NUDGE_INITIAL_DELAY_MS = 55_000 // free slot (taken: 5/10/20/25/30/35/40/45/50/90s)
export const INBOX_NUDGE_INTERVAL_MS = 20_000
// A message younger than this is left alone: a concurrently-starting turn (or
// the send that just created it) may claim it in seconds anyway.
export const MIN_PENDING_AGE_MS = 10_000
// Wall-clock-global floor between nudges. Deliberately NOT reset when the
// inbox empties: nudge -> drain empties the inbox on the next tick, so a full
// state reset would let a message stream re-nudge every ~20-30s.
export const NUDGE_DEBOUNCE_MS = 60_000
// Re-nudging the SAME oldest message means the previous nudge did not lead to
// a claim (hook broken, session wedged, prompt lost): slow down hard, and
// after MAX_STALE_NUDGES stop and alert the owner once per spell.
export const STALE_NUDGE_COOLDOWN_MS = 5 * 60_000
export const MAX_STALE_NUDGES = 3
// Rolling hourly cap on autonomous turn generation (each nudge is a paid
// Claude turn). Exhaustion degrades to the baseline drain cadence (next
// human/scheduled prompt), never to message loss.
export const MAX_NUDGES_PER_HOUR = 10
const NUDGE_BUDGET_WINDOW_MS = 60 * 60_000
// Rate limit for the "pending mail is waiting but the session stays busy"
// visibility log -- distinguishes a long busy spell from a dead watcher.
const BUSY_WAIT_LOG_INTERVAL_MS = 10 * 60_000

// Single visual row on the 80-col headless channels pane (see header). Both
// variants MUST stay <= NUDGE_MAX_CHARS (unit-tested). Conditional wording on
// purpose: the drain fires on EVERY main-agent prompt, so a competing prompt
// may have already claimed everything by the time this line submits -- the
// text must not assert that blocks exist above it. Accent-less Hungarian for
// tmux send-keys (channel-monitor precedent); each drained block carries its
// own security preamble, which stays the authoritative framing.
export const NUDGE_MAX_CHARS = 70
export function nudgeText(lang: 'hu' | 'en'): string {
  return lang === 'en'
    ? '[Inbox] If new inbound blocks appear above, process them; else skip.'
    : '[Inbox] Ha fent uj bejovo blokk van, dolgozd fel; ha nincs, hagyd.'
}

export interface NudgeState {
  lastNudgeAt: number
  lastNudgeOldestId: number | null
  staleNudges: number // nudges sent while the oldest pending id stayed unchanged
  staleAlerted: boolean
  recentNudges: number[] // send timestamps within the rolling budget window
  budgetLogged: boolean
  lastBusyLogAt: number
  absenceLogged: boolean
}

export const INITIAL_NUDGE_STATE: NudgeState = Object.freeze({
  lastNudgeAt: 0,
  lastNudgeOldestId: null,
  staleNudges: 0,
  staleAlerted: false,
  recentNudges: [],
  budgetLogged: false,
  lastBusyLogAt: 0,
  absenceLogged: false,
})

export type NudgePreflight =
  | { proceed: false; state: NudgeState; staleAlert?: boolean; budgetLog?: boolean }
  | { proceed: true; state: NudgeState }

/** Pure cheap-checks stage: everything decidable from the DB row + clock,
 *  BEFORE any tmux IO. Returns the next state; the shell only touches tmux
 *  when proceed is true. */
export function decideNudgePreflight(
  input: { now: number; oldestId: number | null; oldestAgeMs: number },
  state: NudgeState,
): NudgePreflight {
  const { now, oldestId, oldestAgeMs } = input
  if (oldestId === null) {
    // Inbox empty: end the spell. lastNudgeAt and the budget window survive
    // (global debounce floor); spell-scoped fields reset.
    if (state.lastNudgeOldestId === null && !state.absenceLogged && state.lastBusyLogAt === 0
      && !state.staleAlerted && state.staleNudges === 0) {
      return { proceed: false, state }
    }
    return {
      proceed: false,
      state: { ...state, lastNudgeOldestId: null, staleNudges: 0, staleAlerted: false, lastBusyLogAt: 0, absenceLogged: false },
    }
  }
  if (oldestAgeMs < MIN_PENDING_AGE_MS) return { proceed: false, state }
  if (now - state.lastNudgeAt < NUDGE_DEBOUNCE_MS) return { proceed: false, state }

  // Stale spell: the previous nudge targeted this same oldest message and it
  // is STILL pending -> the drain did not claim it.
  if (state.lastNudgeOldestId === oldestId && state.staleNudges > 0) {
    if (state.staleNudges >= MAX_STALE_NUDGES) {
      if (!state.staleAlerted) {
        return { proceed: false, staleAlert: true, state: { ...state, staleAlerted: true } }
      }
      return { proceed: false, state }
    }
    if (now - state.lastNudgeAt < STALE_NUDGE_COOLDOWN_MS) return { proceed: false, state }
  }

  // Rolling hourly budget.
  const recent = state.recentNudges.filter((t) => now - t < NUDGE_BUDGET_WINDOW_MS)
  if (recent.length >= MAX_NUDGES_PER_HOUR) {
    if (!state.budgetLogged) {
      return { proceed: false, budgetLog: true, state: { ...state, recentNudges: recent, budgetLogged: true } }
    }
    return { proceed: false, state: { ...state, recentNudges: recent } }
  }
  return { proceed: true, state: { ...state, recentNudges: recent, budgetLogged: false } }
}

/** Pure state advance for a nudge attempt. Called BEFORE the send so a send
 *  that THROWS still consumes the debounce (no 20s-tick retry storm); the
 *  shell restores the previous state only on a clean 'aborted-busy'. */
export function recordNudge(state: NudgeState, now: number, oldestId: number): NudgeState {
  return {
    ...state,
    lastNudgeAt: now,
    staleNudges: state.lastNudgeOldestId === oldestId ? state.staleNudges + 1 : 1,
    staleAlerted: state.lastNudgeOldestId === oldestId ? state.staleAlerted : false,
    lastNudgeOldestId: oldestId,
    recentNudges: [...state.recentNudges.filter((t) => now - t < NUDGE_BUDGET_WINDOW_MS), now],
  }
}

function resolveLang(): 'hu' | 'en' {
  try {
    return getEffectiveSettingValue('DASHBOARD_LANG') === 'en' ? 'en' : 'hu'
  } catch {
    return 'hu'
  }
}

let state: NudgeState = { ...INITIAL_NUDGE_STATE }

/** Test seam. */
export function _resetNudgeStateForTest(): void {
  state = { ...INITIAL_NUDGE_STATE }
}

function tick(): void {
  // The whole body is fenced: sendPromptToSession/tmux helpers throw on tmux
  // failure, this is a synchronous setInterval callback, and an escaped throw
  // would reach the uncaughtException handler and take the dashboard down.
  try {
    const now = Date.now()
    const pending = getPendingMessages(MAIN_AGENT_ID)
    const oldest = pending[0]
    const pre = decideNudgePreflight(
      { now, oldestId: oldest ? oldest.id : null, oldestAgeMs: oldest ? now - oldest.created_at * 1000 : 0 },
      state,
    )
    state = pre.state
    if (!pre.proceed) {
      if (pre.staleAlert) {
        logger.warn({ inboxNudge: true, oldestId: oldest?.id, staleNudges: MAX_STALE_NUDGES }, 'inbox nudge: drain did not claim after repeated nudges; stopping and alerting owner')
        sendAlert(
          `⚠️ A fő-ügynök inbox auto-drain ${MAX_STALE_NUDGES} noszogatás után sem vette át a függő üzenetet (#${oldest?.id}). ` +
          'Valószínű okok: a UserPromptSubmit drain-hook nincs bekötve a session cwd-jéhez (inbox-drain.py), telepítési útvonal-eltérés, ' +
          'vagy a channels-session beragadt. Kézi ellenőrzés kell; a noszogatás szünetel, amíg ez az üzenet függőben van.',
        )
      }
      if (pre.budgetLog) {
        logger.warn({ inboxNudge: true, pending: pending.length, budget: MAX_NUDGES_PER_HOUR }, 'inbox nudge: hourly budget exhausted; falling back to baseline drain cadence')
      }
      return
    }

    if (!sessionExistsOnHost(null, MAIN_CHANNELS_SESSION)) {
      // Smoke/staging instances (RESPAWN_ENABLED=0, sdk backend) never have a
      // channels session -- log once per absence spell, not per tick.
      if (!state.absenceLogged) {
        logger.info({ inboxNudge: true, session: MAIN_CHANNELS_SESSION, pending: pending.length }, 'inbox nudge: channels session absent; mail waits for the next main-agent turn')
        state = { ...state, absenceLogged: true }
      }
      return
    }
    if (state.absenceLogged) state = { ...state, absenceLogged: false }

    if (!isSessionReadyForPrompt(MAIN_CHANNELS_SESSION, null)) {
      // Busy is the NORMAL skip path (silent); surface a long busy-wait spell
      // at a slow rate so it is distinguishable from a dead watcher.
      if (now - state.lastBusyLogAt > BUSY_WAIT_LOG_INTERVAL_MS) {
        logger.info({ inboxNudgeWaiting: true, pending: pending.length, oldestAgeMs: now - oldest.created_at * 1000 }, 'inbox nudge: pending mail waiting; main session busy')
        state = { ...state, lastBusyLogAt: now }
      }
      return
    }

    const prev = state
    state = recordNudge(state, now, oldest.id)
    let result: 'sent' | 'aborted-busy'
    try {
      result = sendPromptToSession(MAIN_CHANNELS_SESSION, nudgeText(resolveLang()), null, {
        onBusyTimeout: 'abort',
        idleTimeoutMs: 2_000,
      })
    } catch (err) {
      // A tmux throw means NOTHING was typed -- same as aborted-busy. Restore
      // the pre-send state so a transient send failure does NOT inflate the
      // stale-nudge counter and mis-fire the "drain hook broken" owner alert
      // (which would misdirect the operator; the real cause is send-side).
      state = prev
      logger.warn({ err, pending: pending.length }, 'inbox nudge: send threw; nothing typed, state restored')
      return
    }
    if (result === 'aborted-busy') {
      // The pane turned busy in the check->send gap; nothing was typed. Undo
      // the debounce so the normal cadence retries.
      state = prev
      logger.info({ inboxNudgeSkipped: 'busy', pending: pending.length }, 'inbox nudge: pane turned busy before send; skipped')
      return
    }
    logger.info(
      { inboxNudge: true, pending: pending.length, oldestId: oldest.id, nudgesInLastHour: state.recentNudges.length },
      'inbox nudge: prompted the main agent to drain its inbox',
    )
  } catch (err) {
    logger.warn({ err }, 'inbox nudge: tick error')
  }
}

export function startInboxNudgeWatcher(): NodeJS.Timeout {
  setTimeout(tick, INBOX_NUDGE_INITIAL_DELAY_MS).unref()
  return setInterval(tick, INBOX_NUDGE_INTERVAL_MS)
}
