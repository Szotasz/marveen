import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { isAgentRunning, captureParkedInputView, sendEnterToSession } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { recoverStuckInputForSession, sendAlert } from './channel-monitor.js'
import {
  stuckInputSignature,
  decideStuckInputRecovery,
  type StuckInputState,
  type StuckInputThresholds,
} from '../pane-state.js'

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
function checkLocalSession(label: string, session: string, alertOnGiveUp: boolean, allowPlainReinject: boolean): void {
  const prev = watchState.get(session) ?? NO_STATE
  const next = recoverStuckInputForSession(session, prev, LOCAL_FAST_THRESHOLDS, allowPlainReinject)

  if (next.parkedSig === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
    if (
      alertOnGiveUp &&
      next.attempts >= LOCAL_FAST_THRESHOLDS.maxAttempts &&
      prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts
    ) {
      logger.warn({ label, session }, 'stuck-input-watcher: sub-agent input still parked after max recovery attempts, alerting for manual restart')
      sendAlert(`⚠️ A(z) ${label} agens bemenete beragadt és az auto-recovery (Enter + clear/re-inject) nem szabadította ki. Valószínűleg kézi restart kell: POST /api/agents/${label}/restart vagy a dashboardon.`)
    }
  }
}

export function startStuckInputWatcher(): NodeJS.Timeout {
  function sweep() {
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
      checkLocalSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, false, false)
    } catch (err) {
      logger.debug({ err }, 'stuck-input-watcher: main agent check error')
    }
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        watchState.delete(resolveAgentSession(name))
        continue
      }
      const session = resolveAgentSession(name)
      const host = readAgentRemoteHost(name)
      try {
        // Local sub-agents get the full robust escalation (with a give-up
        // alert); remote-host ones (no local tmux for clear+re-inject) stay on
        // the host-aware bare Enter.
        if (host == null) {
          checkLocalSession(name, session, true, true)
        } else {
          bareEnterRecovery(name, session, host)
        }
      } catch (err) {
        logger.debug({ err, agent: name }, 'stuck-input-watcher: agent check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
