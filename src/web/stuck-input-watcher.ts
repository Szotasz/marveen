import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { isAgentRunning, captureParkedInputView, sendEnterToSession, capturePane } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { recoverStuckInputForSession, sendAlert, clearParkedInputUnderLane, onClearResult } from './channel-monitor.js'
import { createAgentMessage, listPendingTaskRetries, type PendingTaskRetryRow } from '../db.js'
import {
  stuckInputSignature,
  parkedPasteSignature,
  parkedScheduledPasteSignature,
  decideStuckInputRecovery,
  detectPaneState,
  type PaneState,
  type StuckInputState,
  type StuckInputThresholds,
} from '../pane-state.js'
import { whileNotFrozen } from './fleet-freeze.js'

/**
 * The owner alert for an input recovery gave up on. A sub-agent restarts through its own route. The MAIN
 * agent's manual restart is gated (manual-restart-gate.ts): a parked input reads as a non-idle pane, so a
 * plain POST answers 409 there. The alert names the paths that work: the dashboard button, which asks
 * before it forces, or an explicit force.
 */
export function parkedGiveUpAlertText(label: string, isMain: boolean): string {
  const head = `⚠️ A(z) ${label} agens bemenete beragadt és az auto-recovery (Enter + clear/re-inject) nem szabadította ki.`
  if (isMain) {
    return `${head} Valószínűleg kézi restart kell: a dashboardon a restart gomb (foglalt panelnél rákérdez, és megerősítés után kényszerítve indít), vagy POST /api/marveen/restart {"force": true}. A kényszerített restart megszakítja a futó kört.`
  }
  return `${head} Valószínűleg kézi restart kell: POST /api/agents/${label}/restart vagy a dashboardon.`
}

/** The main-agent notice for a sub-agent whose parked input the recovery gave up on. */
export function parkedGiveUpOrchestratorText(label: string, session: string): string {
  return `[stuck-input] Agent '${label}' (tmux ${session}) still has parked input after the auto-recovery (Enter + clear/re-inject) at a non-busy pane. Check the pane: if the parked text is ours, press Enter; if the session is wedged, restart it (POST /api/agents/${label}/restart). Escalate to the owner only if it cannot be fixed.`
}

// RIASZTASZAJ819: the owner alert for a parked-past-max-attempts sub-agent
// fired three times in one afternoon at an agent that was WORKING the whole
// time (its outbound messages bracket every alert timestamp). Parked input at
// a BUSY agent is normal: a message that arrives mid-turn sits in the TUI
// until the turn ends and then submits on its own. The recovery Enters are
// harmless and stay; only the OWNER ESCALATION must require an idle pane.
//
// PURE decision, unit-tested: alert exactly once per spell, and only when the
// give-up threshold is spent AND the pane is NOT busy at this tick.
//   - 'busy'            -> suppress (waiting, not wedged). The spell stays
//                          open, so if the turn ends and the input is STILL
//                          parked, a later idle tick fires the alert -- the
//                          real bug is never silenced, only deferred to the
//                          moment it is distinguishable from waiting.
//   - idle/typing/unknown -> alert: parked input at a non-busy pane after all
//                          recovery attempts is the genuine wedge ('unknown'
//                          deliberately alerts -- an unreadable pane with a
//                          stuck spell deserves eyes, not silence).
export function shouldAlertParkedGiveUp(opts: {
  attempts: number
  maxAttempts: number
  alreadyAlerted: boolean
  paneState: PaneState | null
}): boolean {
  const { attempts, maxAttempts, alreadyAlerted, paneState } = opts
  if (alreadyAlerted) return false
  if (attempts < maxAttempts) return false
  if (paneState === 'busy') return false
  return true
}

// Backstop recovery for a swallowed Enter on the channel-notification
// path. Inbound Telegram/Slack messages are delivered into the session by
// the channel plugin, NOT by sendPromptToSession, so the post-send
// Enter-retry budget there cannot cover them. After a long thinking turn
// the closing Enter is occasionally dropped and the user's message is
// left parked in the prompt box with no submit. This watcher captures
// each running agent's pane on a timer, and when the SAME text has been
// parked past the confirm window it recovers it.
//
// REMOTE sub-agents: conservative -- bare recovery Enter only (host-aware).
// channel-monitor owns the clear+re-inject escalation at the slower 60s
// cadence, and re-inject (clear + sendPromptToSession) is local-tmux only, so
// a remote-host agent cannot use it here.
//
// LOCAL sessions (the MAIN channels session AND local sub-agents): this fast
// 15s loop drives the FULL robust escalation (Enter-first, then clear +
// re-inject of the COMPLETE <channel> block or, for a sub-agent, any complete
// parked text) via the shared recoverStuckInputForSession. A bare Enter is
// frequently swallowed by the Claude TUI in raw mode, so the previous "Enter
// x3 then give up" left a parked input wedged for minutes until
// channel-monitor's slow escalation (or a manual restart) caught up. Running
// the real re-inject here drops the mean-time-to-recovery from ~3min to
// ~30-45s and actually SUBMITS the message. channel-monitor stays as a slower
// backstop (and owns MAIN's give-up alert + rate-limited hard restart); in
// practice this loop clears the spell long before the 90s-confirm backstop
// escalates, so they do not double-act.
//
// The escalation/decision logic is the pure recoverStuckInputForSession +
// decideStuckInputRecovery (unit-tested in pane-state); this module is only
// the I/O + per-session state map, mirroring channel-health-monitor.ts.

// REMOTE sub-agents: bare-Enter recovery only (no local tmux for re-inject).
const THRESHOLDS: StuckInputThresholds = {
  // The same text must stay parked this long before the first recovery
  // Enter. A real turn transitions typing -> busy within a second or two
  // of submit, so 10s comfortably clears the frame race while still
  // recovering a genuinely swallowed Enter quickly.
  confirmMs: 10_000,
  // Gap between recovery Enters within one spell.
  dedupMs: 12_000,
  // A pane still parked after this many Enters is not the swallowed-Enter
  // case (e.g. a paste placeholder, which detectPaneState already treats
  // as busy and so never reaches here anyway); stop and log.
  maxAttempts: 3,
}

// LOCAL full-escalation thresholds: drive the robust escalation on the fast
// tick for any LOCAL session (the MAIN channels session and local sub-agents).
// confirm/dedup are aligned to the 15s interval so the first Enter fires
// after ~1 confirm window, the two Enter attempts are spent within ~2-3
// ticks, and clear+re-inject escalation begins ~30-45s in (vs ~3min on the
// 60s channel-monitor). maxAttempts leaves room for 2 Enters + 3 re-inject
// attempts before giving up and alerting.
const LOCAL_FAST_THRESHOLDS: StuckInputThresholds = {
  confirmMs: 12_000,
  dedupMs: 12_000,
  maxAttempts: 5,
}

const INITIAL_DELAY_MS = 20_000
const INTERVAL_MS = 15_000

const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

const watchState = new Map<string, StuckInputState>()
// One owner alert per spell (RIASZTASZAJ819): entries live while a spell is
// open and are dropped with it, so a NEW spell on the same session alerts
// again. Not persisted -- a dashboard restart may re-alert once, acceptable.
const alertedSpells = new Set<string>()

// Backstop for a PARKED `[Pasted text #N]` placeholder -- a long inbound prompt
// (e.g. a scheduled-task notice > ~700 chars) the TUI collapsed into a paste
// stub whose trailing Enter was swallowed. detectPaneState reads a placeholder
// as 'busy' (correct for the scheduler: don't pile a second prompt on), so the
// 'typing'-gated recovery in checkLocalSession / bareEnterRecovery NEVER fires
// for it and the stub sat parked until a manual keystroke. This runs FIRST per
// session: a placeholder and a typing-parked box are mutually exclusive (a
// placeholder forces detectPaneState -> 'busy', so stuckInputSignature is null),
// so handling the paste case here and skipping the normal path on the same tick
// cannot double-act on one session.
//
// Recovery is a BARE Enter only -- a placeholder submits on a single Enter even
// though it renders across multiple visual rows, and the collapsed paste body is
// not recoverable from the pane (clear + re-inject would DESTROY it). A bare
// Enter submits the real pasted content verbatim, exactly what the manual
// keystroke does. Host-aware, so a remote sub-agent is covered too. Time-gated
// through the shared decideStuckInputRecovery so a healthy paste that submits on
// its own within the confirm window is never Enter-spammed.
//
// Returns true when a parked-paste spell is active (recovered or still inside
// its confirm/dedup window) so the caller SKIPS the normal recovery this tick;
// false when there is no parked paste (caller runs the normal 'typing' path).
function recoverParkedPaste(
  label: string,
  session: string,
  host: string | null,
  thresholds: StuckInputThresholds,
): boolean {
  const pane = captureParkedInputView(session, host)
  const sig = pane == null ? null : parkedPasteSignature(pane)
  if (sig == null) return false

  const prev = watchState.get(session) ?? NO_STATE
  const { recover, next } = decideStuckInputRecovery(sig, prev, Date.now(), thresholds)
  watchState.set(session, next)

  if (recover) {
    logger.info(
      { label, session, attempt: next.attempts },
      'stuck-input-watcher: parked paste placeholder persisted past confirm window, sending recovery Enter',
    )
    sendEnterToSession(session, host)
  } else if (next.attempts >= thresholds.maxAttempts && prev.attempts < thresholds.maxAttempts) {
    logger.warn(
      { label, session },
      'stuck-input-watcher: paste placeholder still parked after max recovery Enters, giving up for this spell',
    )
  }
  return true
}

// SCHEDPASTE1030: a damaged scheduled-task tick (typed text + `[Pasted text #N]`
// stubs, the scheduler's wrapper at the head; parkedScheduledPasteSignature) is
// CLEARED, never Enter-submitted, and only when the box is provably blocking:
//   - the same text has sat there for confirmMs (150s), and
//   - the scheduler has been retrying a task for THIS agent for at least
//     SCHED_PASTE_MIN_RETRY_MS (pending_task_retries) -- it reads the box as
//     "busy or pending input", and a cleared tick is re-delivered by that retry.
// The 2026-10-29 incident held the main pane for 16 hours behind such a box.
// Local sessions only (the clear runs under the local send lane), MAIN included:
// the head match rules out a human draft there.
export const SCHED_PASTE_THRESHOLDS: StuckInputThresholds = {
  confirmMs: 150_000,
  dedupMs: 30_000,
  maxAttempts: 3,
}
export const SCHED_PASTE_MIN_RETRY_MS = 10 * 60_000

/** The oldest first_attempt (ms) of a task the scheduler keeps retrying for this agent, or null. */
export function oldestRetryFor(rows: PendingTaskRetryRow[], agent: string): number | null {
  let oldest: number | null = null
  for (const r of rows) {
    if (r.agent_name === agent && r.first_attempt > 0 && (oldest === null || r.first_attempt < oldest)) oldest = r.first_attempt
  }
  return oldest
}

/**
 * Pure: clear now? decideStuckInputRecovery's spell (confirm window, dedup, attempt budget) plus the
 * scheduler gate. A tick inside the spell but without a long enough retry spends no attempt.
 */
export function decideScheduledPasteClear(opts: {
  sig: string | null
  prev: StuckInputState
  now: number
  retryingSince: number | null
}): { clear: boolean; next: StuckInputState } {
  const { sig, prev, now, retryingSince } = opts
  const d = decideStuckInputRecovery(sig, prev, now, SCHED_PASTE_THRESHOLDS)
  const blocking = retryingSince !== null && now - retryingSince >= SCHED_PASTE_MIN_RETRY_MS
  if (d.recover && !blocking) {
    return { clear: false, next: { ...d.next, lastRecoverAt: prev.lastRecoverAt, attempts: prev.attempts } }
  }
  return { clear: d.recover, next: d.next }
}

export function scheduledPasteGiveUpAlertText(label: string, session: string): string {
  return `⚠️ A(z) ${label} agens beviteli mezőjében egy sérült ütemezett feladat-szöveg ül, és ${SCHED_PASTE_THRESHOLDS.maxAttempts} törlési kísérlet után sem tűnt el, ezért az ütemező nem tud feladatot átadni. Kézi beavatkozás kell (tmux ${session}).`
}

const schedPasteState = new Map<string, StuckInputState>()
const schedPasteAlerted = new Set<string>()

// Returns true when a damaged scheduled tick is parked (handled or still waiting
// out its gates), so the caller skips the bare-Enter paste path and the 'typing'
// path this tick: an Enter would submit the broken tick.
async function clearScheduledPaste(label: string, session: string): Promise<boolean> {
  const pane = captureParkedInputView(session)
  const sig = pane == null ? null : parkedScheduledPasteSignature(pane)
  if (sig == null) {
    schedPasteState.delete(session)
    schedPasteAlerted.delete(session)
    return false
  }
  const prev = schedPasteState.get(session) ?? NO_STATE
  const { clear, next } = decideScheduledPasteClear({
    sig, prev, now: Date.now(), retryingSince: oldestRetryFor(listPendingTaskRetries(), label),
  })
  schedPasteState.set(session, next)
  if (clear) {
    logger.warn({ label, session, attempt: next.attempts }, 'stuck-input-watcher: damaged scheduled-task paste parked and the scheduler is retrying behind it, clearing (no Enter; the retry re-delivers)')
    const result = await clearParkedInputUnderLane(session)
    if (result === 'skipped-locked') {
      logger.info({ label, session }, 'stuck-input-watcher: scheduled-paste clear skipped, a delivery is in flight into this pane (fail-closed)')
      return true
    }
    // clearInputBuffer verifies with stuckInputSignature, which is blind to a stub
    // (the pane reads 'busy'), so check the box again with this path's own detector.
    const after = captureParkedInputView(session)
    const left = after == null ? null : (parkedScheduledPasteSignature(after) ?? stuckInputSignature(after))
    onClearResult(session, left == null ? 'cleared' : 'left-fragment')
    if (left == null) logger.info({ label, session }, 'stuck-input-watcher: damaged scheduled-task paste cleared')
    else logger.warn({ label, session, left: left.slice(0, 80) }, 'stuck-input-watcher: scheduled-paste clear left text in the box')
  } else if (next.attempts >= SCHED_PASTE_THRESHOLDS.maxAttempts && !schedPasteAlerted.has(session)) {
    schedPasteAlerted.add(session)
    logger.warn({ label, session }, 'stuck-input-watcher: damaged scheduled-task paste still parked after max clears, alerting')
    sendAlert(scheduledPasteGiveUpAlertText(label, session))
  }
  return true
}

// Bare-Enter recovery (host-aware). Used for the MAIN session (host null) and
// for REMOTE sub-agents, where the local-tmux clear+re-inject is not
// available. channel-monitor owns the clear+re-inject escalation for these.
function bareEnterRecovery(label: string, session: string, host: string | null): void {
  // Ghost-stripped capture: a bare recovery Enter submits whatever is parked,
  // so a dim autocomplete hint read as parked input would be Enter-submitted as
  // a forged message. captureParkedInputView removes the SGR-2 ghost first.
  const pane = captureParkedInputView(session, host)
  // A failed capture is treated as "nothing parked" -- it ends any active
  // spell rather than holding stale state across a transient tmux miss.
  const sig = pane == null ? null : stuckInputSignature(pane)

  const prev = watchState.get(session) ?? NO_STATE
  const { recover, next } = decideStuckInputRecovery(sig, prev, Date.now(), THRESHOLDS)

  if (next.parkedSig === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
  }

  if (recover) {
    logger.info(
      { label, session, attempt: next.attempts },
      'stuck-input-watcher: parked input persisted past confirm window, sending recovery Enter',
    )
    sendEnterToSession(session, host)
  } else if (next.parkedSig !== null && next.attempts >= THRESHOLDS.maxAttempts) {
    // Logged at most once per spell: the give-up is recorded on the tick
    // that spent the last attempt (attempts hits maxAttempts there), not
    // every subsequent tick.
    if (prev.attempts < THRESHOLDS.maxAttempts) {
      logger.warn({ label, session }, 'stuck-input-watcher: input still parked after max recovery Enters, giving up for this spell')
    }
  }
}

// LOCAL session: full robust escalation (Enter -> clear + re-inject) on the
// fast tick. Used for the MAIN channels session AND local sub-agents -- both
// are local tmux, so the clear+re-inject applies. This drops the
// mean-time-to-recovery for a swallowed Enter from ~3min to ~30-45s.
//
// alertOnGiveUp: a local SUB-agent that is still parked after maxAttempts
// surfaces a one-shot alert for a manual restart. The MAIN channels session
// passes FALSE here -- its give-up alert AND the rate-limited hard restart are
// owned by channel-monitor (maybeRestartWedgedMainChannel); alerting here too
// would double-escalate. The fast 15s loop (12s confirm) always reaches its
// recovery long before channel-monitor's 90s confirm, so the two layers do not
// double-act on MAIN.
//
// allowPlainReinject: gates the PLAIN-text re-inject branch (re-typing any
// parked non-<channel> text). MAIN passes FALSE -- a dim prompt-suggestion
// ghost in the MAIN box (no CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION env-var there,
// that is sub-agent-spawn-only) would otherwise be re-typed + submitted as a
// forged message (the 2026-06-26 phantom-injection class). With FALSE, MAIN
// still gets the fast clear+re-inject of a COMPLETE parked <channel> block
// (its real goal -- a stranded Telegram message; that path is independent of
// this flag), only the ghost-risky plain-text branch is closed. Local
// sub-agents pass TRUE: the env-var strips their ghost at the source, so their
// plain re-inject (an inter-agent message the TUI failed to submit) is safe.
async function checkLocalSession(label: string, session: string, alertOnGiveUp: boolean, allowPlainReinject: boolean): Promise<void> {
  const prev = watchState.get(session) ?? NO_STATE
  const next = await recoverStuckInputForSession(session, prev, LOCAL_FAST_THRESHOLDS, allowPlainReinject)

  if (next.parkedSig === null) {
    watchState.delete(session)
    alertedSpells.delete(session)
  } else {
    watchState.set(session, next)
    if (alertOnGiveUp && next.attempts >= LOCAL_FAST_THRESHOLDS.maxAttempts) {
      // RIASZTASZAJ819: the owner escalation requires an IDLE pane. A parked
      // input at a busy agent is a message waiting out the current turn, not
      // a wedge -- three false owner alerts in one afternoon came from
      // exactly this (the agent's own outbound messages bracketed every
      // alert). Recovery attempts above are untouched; only the alert gates.
      const pane = capturePane(session)
      const paneState = pane != null ? detectPaneState(pane) : null
      if (shouldAlertParkedGiveUp({
        attempts: next.attempts,
        maxAttempts: LOCAL_FAST_THRESHOLDS.maxAttempts,
        alreadyAlerted: alertedSpells.has(session),
        paneState,
      })) {
        alertedSpells.add(session)
        logger.warn({ label, session, paneState }, 'stuck-input-watcher: sub-agent input still parked after max recovery attempts at a non-busy pane, alerting for manual restart')
        if (session === MAIN_CHANNELS_SESSION) {
          sendAlert(parkedGiveUpAlertText(label, true))
        } else {
          // A parked sub-agent goes to the main agent, not the owner's channel:
          // the main agent can read the pane and press Enter or restart, which
          // is everything the owner could do (and owners asked not to be paged
          // for it). The main session itself still alerts the owner -- nobody
          // else can act on it.
          createAgentMessage('system', MAIN_AGENT_ID, parkedGiveUpOrchestratorText(label, session))
        }
      } else if (paneState === 'busy' && prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts) {
        // Once per spell, at the crossing tick: say WHY no alert went out, so
        // a real wedge investigation finds the suppression instead of a hole.
        logger.info({ label, session }, 'stuck-input-watcher: parked past max attempts but the pane is BUSY -- input is waiting out the turn, owner alert suppressed until an idle tick (RIASZTASZAJ819)')
      }
    }
  }
}

export function startStuckInputWatcher(): NodeJS.Timeout {
  async function sweep() {
    // The main agent's channels session is named `<id>-channels`, not
    // `agent-<id>`, so isAgentRunning (which checks the agent- prefix)
    // does not apply. Check it directly; capturePane returns null when it
    // is not up, which ends any spell without acting. Main is always local,
    // so it gets the FULL escalation (Enter -> clear + re-inject of the parked
    // <channel> block) here -- previously it was bare-Enter-only and a
    // swallowed Enter could leave an inbound channel message parked until the
    // 60s channel-monitor re-injected it. allowPlainReinject=false: MAIN gets
    // the <channel>-block re-inject but NOT the ghost-risky plain-text branch
    // (no prompt-suggestion env-var on the main session). The give-up alert +
    // the rate-limited hard restart stay owned by channel-monitor (alert=false).
    try {
      // Parked paste placeholder takes precedence (mutually exclusive with a
      // typing-parked box); only run the normal 'typing' recovery when there is
      // no stuck paste this tick. A damaged scheduled tick (SCHEDPASTE1030) goes
      // first: it is a paste too, but must be cleared, never Enter-submitted.
      if (!(await clearScheduledPaste(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION))
        && !recoverParkedPaste(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, null, LOCAL_FAST_THRESHOLDS)) {
        await checkLocalSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, false, false)
      }
    } catch (err) {
      logger.debug({ err }, 'stuck-input-watcher: main agent check error')
    }
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        watchState.delete(resolveAgentSession(name))
        schedPasteState.delete(resolveAgentSession(name))
        continue
      }
      const session = resolveAgentSession(name)
      const host = readAgentRemoteHost(name)
      try {
        // Local sub-agents get the full robust escalation (with a give-up
        // alert); remote-host ones (no local tmux for clear+re-inject) stay on
        // the host-aware bare Enter. In both cases a parked paste placeholder is
        // handled first via a time-gated bare Enter (the 'typing'-gated paths
        // below never see it -- a placeholder reads as 'busy').
        if (host == null) {
          if (!(await clearScheduledPaste(name, session)) && !recoverParkedPaste(name, session, null, LOCAL_FAST_THRESHOLDS)) {
            await checkLocalSession(name, session, true, true)
          }
        } else {
          if (!recoverParkedPaste(name, session, host, THRESHOLDS)) {
            bareEnterRecovery(name, session, host)
          }
        }
      } catch (err) {
        logger.debug({ err, agent: name }, 'stuck-input-watcher: agent check error')
      }
    }
  }

  setTimeout(whileNotFrozen('stuck-input', () => { void sweep() }), INITIAL_DELAY_MS)
  return setInterval(whileNotFrozen('stuck-input', () => { void sweep() }), INTERVAL_MS)
}
