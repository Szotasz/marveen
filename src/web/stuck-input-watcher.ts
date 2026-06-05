import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { isAgentRunning, capturePane, sendEnterToSession } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
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
// parked past the confirm window it re-sends Enter to submit it.
//
// All the decision logic is the pure decideStuckInputRecovery() in
// pane-state.ts (unit-tested); this module is only the I/O + per-session
// state map, mirroring channel-health-monitor.ts.

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

// Initial delay before the first sweep, and the sweep interval. Offset
// from channel-monitor (30s) and channel-health-monitor (45s) so the
// three watchers do not pile their capture-pane calls onto one tick.
const INITIAL_DELAY_MS = 20_000
const INTERVAL_MS = 15_000

const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

const watchState = new Map<string, StuckInputState>()

function checkSession(label: string, session: string, host: string | null = null): void {
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
    // every subsequent tick, because once at the cap recover stays false
    // and attempts no longer increments.
    if (prev.attempts < THRESHOLDS.maxAttempts) {
      logger.warn({ label, session }, 'stuck-input-watcher: input still parked after max recovery Enters, giving up for this spell')
    }
  }
}

export function startStuckInputWatcher(): NodeJS.Timeout {
  function sweep() {
    // The main agent's channels session is named `<id>-channels`, not
    // `agent-<id>`, so isAgentRunning (which checks the agent- prefix)
    // does not apply. Check it directly; capturePane returns null when it
    // is not up, which ends any spell without acting.
    try {
      checkSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'stuck-input-watcher: main agent check error')
    }
    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) {
        watchState.delete(resolveAgentSession(name))
        continue
      }
      try {
        checkSession(name, resolveAgentSession(name), readAgentRemoteHost(name))
      } catch (err) {
        logger.debug({ err, agent: name }, 'stuck-input-watcher: agent check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
