import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { isAgentRunning, captureParkedInputView, sendEnterToSession, capturePane, restartAgentProcess } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { recoverStuckInputForSession, sendAlert } from './channel-monitor.js'
import {
  stuckInputSignature,
  parkedPasteSignature,
  decideStuckInputRecovery,
  decideSubAgentWedgeRestart,
  detectPaneState,
  parkedInputHasRemedy,
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
  // A sub-agent also has the automatic wedge escalation below, so say that the
  // manual route is the fallback, not the only way out -- otherwise the restart
  // that lands ~WEDGE_GRACE_MS later reads as something nobody asked for.
  return `${head} Valószínűleg kézi restart kell: POST /api/agents/${label}/restart vagy a dashboardon. Ha ${Math.round(WEDGE_GRACE_MS / 60_000)} percen belül nem oldódik fel, magamtól is megkísérlem az újraindítást.`
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

// --- Sub-agent no-remedy wedge escalation (2026-08-13 designer/Frida) ---
//
// Before this, a local sub-agent that exhausted soft recovery got ONE alert and
// then stayed mute forever (designer: 4 days across a dashboard restart). This
// is the sub-agent counterpart of channel-monitor's maybeRestartWedgedMainChannel.
// The pure gate lives in pane-state (decideSubAgentWedgeRestart); everything
// here is I/O + the per-session bookkeeping.
//
// The grace window is deliberately long: it is what stands in for MAIN's
// machineOrigin guard (unavailable here -- see the pane-state comment), so it
// must stay far longer than any plausible human pause mid-composition.
const WEDGE_GRACE_MS = 10 * 60 * 1000
const WEDGE_RESTART_MIN_INTERVAL_MS = 20 * 60 * 1000
const WEDGE_RESTART_MAX_CONSECUTIVE = 2

// Age clock for the CURRENT parked text. Reset whenever the text changes (a new
// spell is not the old one) and dropped when the box clears.
const wedgeAge = new Map<string, { sig: string; firstSeenAt: number }>()
// Restart bookkeeping. Mirrors MAIN: the consecutive-restart COUNT resets as
// soon as the box clears (a successful restart is not penalised), but
// lastRestartAt PERSISTS across that reset -- otherwise the post-restart empty
// box would erase the rate limit and a re-wedge could restart immediately.
const wedgeRestarts = new Map<string, { lastRestartAt: number; count: number }>()

export function resetSubAgentWedgeState(session?: string): void {
  if (session == null) { wedgeAge.clear(); wedgeRestarts.clear(); return }
  wedgeAge.delete(session)
  wedgeRestarts.delete(session)
}

// Escalate a LOCAL sub-agent that soft recovery has given up on. Runs only
// after checkLocalSession has spent its whole attempts budget, so the extra
// pane captures here cost nothing on a healthy fleet.
async function maybeRestartWedgedSubAgent(label: string, session: string, state: StuckInputState): Promise<void> {
  const now = Date.now()
  const book = wedgeRestarts.get(session) ?? { lastRestartAt: 0, count: 0 }

  if (state.parkedSig === null) {
    // Box clear -> spell over. Drop the age clock and forgive the count, but
    // KEEP lastRestartAt so the rate limit survives a restart.
    wedgeAge.delete(session)
    if (book.count !== 0) wedgeRestarts.set(session, { ...book, count: 0 })
    return
  }

  const age = wedgeAge.get(session)
  const clock = age != null && age.sig === state.parkedSig ? age : { sig: state.parkedSig, firstSeenAt: now }
  wedgeAge.set(session, clock)

  // Cheap exit before any tmux capture: soft recovery still has budget left.
  if (state.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts) return

  const paneContent = capturePane(session)
  const paneState = paneContent != null ? detectPaneState(paneContent) : null
  const parkedView = captureParkedInputView(session)
  // Unreadable pane -> assume a remedy exists (fail SAFE = do not restart).
  const softRemedy = parkedView == null || parkedInputHasRemedy(parkedView, true)

  const action = decideSubAgentWedgeRestart({
    parked: true,
    attempts: state.attempts,
    maxAttempts: LOCAL_FAST_THRESHOLDS.maxAttempts,
    softRemedy,
    paneState,
    wedgeAgeMs: now - clock.firstSeenAt,
    graceMs: WEDGE_GRACE_MS,
    now,
    lastRestartAt: book.lastRestartAt,
    restartCount: book.count,
    minIntervalMs: WEDGE_RESTART_MIN_INTERVAL_MS,
    maxConsecutive: WEDGE_RESTART_MAX_CONSECUTIVE,
  })

  if (action === 'skip') return

  if (action === 'alert') {
    logger.error({ label, session, restarts: book.count }, 'Sub-agent wedge survived every automatic restart -- manual intervention needed')
    sendAlert(`⛔ A(z) ${label} agens bemenete beragadt es ${WEDGE_RESTART_MAX_CONSECUTIVE} automatikus ujrainditas sem szabaditotta ki. Kezi beavatkozas kell.`)
    wedgeRestarts.set(session, { ...book, count: book.count + 1 }) // tick past the cap: alert once
    return
  }

  logger.warn(
    { label, session, attempts: state.attempts, wedgeMinutes: Math.round((now - clock.firstSeenAt) / 60_000), restart: book.count + 1 },
    'Sub-agent input wedged with no soft remedy -- escalating to a restart (the parked fragment is unsubmittable and is lost)',
  )
  const r = await restartAgentProcess(label)
  wedgeRestarts.set(session, { lastRestartAt: now, count: r.ok ? book.count + 1 : book.count })
  if (r.ok) {
    // Re-evaluate the fresh pane cleanly on the next tick.
    watchState.delete(session)
    wedgeAge.delete(session)
    sendAlert(`♻️ A(z) ${label} agens bemenete beragadt es magatol nem oldodott fel, ezert ujrainditottam. A beragadt uzenet elveszett, ha fontos volt, kuldd ujra.`)
  } else {
    logger.error({ label, session, err: r.error }, 'Sub-agent wedge restart failed')
  }
}

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
        logger.warn({ label, session, paneState }, 'stuck-input-watcher: sub-agent input still parked after max recovery attempts at a non-busy pane, alerting before the wedge restart')
        sendAlert(parkedGiveUpAlertText(label, session === MAIN_CHANNELS_SESSION))
      } else if (paneState === 'busy' && prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts) {
        // Once per spell, at the crossing tick: say WHY no alert went out, so
        // a real wedge investigation finds the suppression instead of a hole.
        logger.info({ label, session }, 'stuck-input-watcher: parked past max attempts but the pane is BUSY -- input is waiting out the turn, owner alert suppressed until an idle tick (RIASZTASZAJ819)')
      }
    }
  }

  // alertOnGiveUp marks the LOCAL SUB-AGENT path (MAIN passes false and keeps
  // its own escalation in channel-monitor). Runs on both branches so a cleared
  // box also ends the wedge spell.
  if (alertOnGiveUp) {
    try {
      await maybeRestartWedgedSubAgent(label, session, next)
    } catch (err) {
      logger.warn({ err, label, session }, 'Sub-agent wedge escalation failed')
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
      // no stuck paste this tick.
      if (!recoverParkedPaste(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, null, LOCAL_FAST_THRESHOLDS)) {
        await checkLocalSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, false, false)
      }
    } catch (err) {
      logger.debug({ err }, 'stuck-input-watcher: main agent check error')
    }
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        const stopped = resolveAgentSession(name)
        watchState.delete(stopped)
        // A stopped agent has no wedge; drop the age clock but KEEP the restart
        // book, so a restart-loop cannot be laundered through a stop/start.
        wedgeAge.delete(stopped)
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
          if (!recoverParkedPaste(name, session, null, LOCAL_FAST_THRESHOLDS)) {
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

  setTimeout(() => { void sweep() }, INITIAL_DELAY_MS)
  return setInterval(whileNotFrozen('stuck-input', () => { void sweep() }), INTERVAL_MS)
}
