import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { isAgentRunning, capturePane, sendEnterToSession } from './agent-process.js'
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
// MAIN session + REMOTE sub-agents: conservative -- bare recovery Enter
// only (host-aware). channel-monitor owns the clear+re-inject escalation at
// the slower 60s cadence, and re-inject (clear + sendPromptToSession) is
// local-tmux only, so a remote-host agent cannot use it here.
//
// LOCAL sub-agents: this fast 15s loop drives the FULL robust escalation
// (Enter-first, then clear + re-inject of the COMPLETE <channel> block or,
// for a sub-agent, any complete parked text) via the shared
// recoverStuckInputForSession. A bare Enter is frequently swallowed by the
// Claude TUI in raw mode, so the previous "Enter x3 then give up" left
// sub-agents wedged for minutes until channel-monitor's slow escalation (or
// a manual restart) caught up. Running the real re-inject here drops the
// mean-time-to-recovery from ~3min to ~30-45s and actually SUBMITS the
// message. channel-monitor stays as a slower backstop; in practice this
// loop clears the spell long before the 90s-confirm backstop escalates, so
// they do not double-act.
//
// The escalation/decision logic is the pure recoverStuckInputForSession +
// decideStuckInputRecovery (unit-tested in pane-state); this module is only
// the I/O + per-session state map, mirroring channel-health-monitor.ts.

// MAIN session + remote sub-agents: bare-Enter recovery only.
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

// LOCAL sub-agent thresholds: drive the robust escalation on the fast tick.
// confirm/dedup are aligned to the 15s interval so the first Enter fires
// after ~1 confirm window, the two Enter attempts are spent within ~2-3
// ticks, and clear+re-inject escalation begins ~30-45s in (vs ~3min on the
// 60s channel-monitor). maxAttempts leaves room for 2 Enters + 3 re-inject
// attempts before giving up and alerting.
const SUB_THRESHOLDS: StuckInputThresholds = {
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
  const pane = capturePane(session, host)
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

// LOCAL sub-agent: full robust escalation (Enter -> clear + re-inject) on the
// fast tick. On give-up (still parked after maxAttempts) alert the Boss once
// so a truly wedged TUI surfaces for a manual restart before the user notices.
function checkLocalSubAgent(label: string, session: string): void {
  const prev = watchState.get(session) ?? NO_STATE
  const next = recoverStuckInputForSession(session, prev, SUB_THRESHOLDS, true)

  if (next.parkedSig === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
    if (next.attempts >= SUB_THRESHOLDS.maxAttempts && prev.attempts < SUB_THRESHOLDS.maxAttempts) {
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
    // is not up, which ends any spell without acting. Main is always local.
    try {
      bareEnterRecovery(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, null)
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
        // Local sub-agents get the full robust escalation; remote-host ones
        // (no local tmux for clear+re-inject) stay on the host-aware Enter.
        if (host == null) {
          checkLocalSubAgent(name, session)
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
