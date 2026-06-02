// Stuck tool-call watchdog for the main channels session (2026-06-02 incident).
//
// Symptom & root cause (from cold-memory entry `marveen,deafness,Worked for`):
//   Marveen's TUI gets stuck at "Worked for 31s" indefinitely. The Telegram
//   reply tool-call hung server-side (no client-side timeout), and the
//   claude TUI render loop blocks on its stdio pipe. CPU drops to 0.3%,
//   IO-wait. The bun channel-plugin poller is still alive, so #240's
//   bun-alive short-circuit hides the freeze from the main recovery cascade --
//   stage 1-4 never fires. Inbound traffic is read by bun and delivered into
//   the prompt buffer, but the TUI can never act on it: Szabi sees "Marveen
//   válaszol, de a válasz nem jön meg Telegramra".
//
// Detection: parse the TUI's "<verb> for Ns" progress line; if the same
// tag+seconds is observed across multiple polls AND the seconds value has
// reached freezeSeconds, the tool-call is wedged. Recovery is a fresh
// respawn (hardRestartMarveenChannels), which goes through channels.sh and
// hence picks up all the existing safety nets (#231, #232, #234, #236).
//
// Critical guard (Marveen 2026-06-02 review): a legitimate long-running
// tool-call (slow Anthropic inference, multi-stage research agent) MUST
// NOT trigger this. Two layers of false-positive protection:
//   1. seconds >= freezeSeconds (180s default) -- below that, just record.
//   2. The counter must be STAGNANT for stagnantPolls (2 default) consecutive
//      polls. A real tool-call increments the seconds every TUI redraw
//      (~once per second). A non-incrementing counter across two 30s poll
//      intervals (60s wall clock at least) is the wedge signature.
// A real wedge satisfies BOTH. A real slow-but-progressing tool-call fails
// the second (counter keeps incrementing) so we never act.
//
// Scope: MAIN channels session only. Sub-agents are managed by Marveen
// inter-agent; their tool-call freezes are not user-facing in the same way
// and the respawn path (stopAgentProcess + startAgentProcess) is different.
// Extend if a sub-agent case ever materialises.

import { logger } from '../logger.js'
import { capturePane } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { hardRestartMarveenChannels } from './channel-monitor.js'
import {
  stuckToolCallSignature,
  decideStuckToolCallRecovery,
  type StuckToolCallState,
  type StuckToolCallThresholds,
} from '../pane-state.js'

// Defaults chosen against the 2026-06-02 incident profile.
//   - freezeSeconds = 180: long enough that a real slow Anthropic call
//     (multi-thousand-token thinking + tool result) doesn't trip it. The
//     observed wedge sat at 31s, but the seconds value when the freeze
//     actually started is irrelevant -- a wedged 31s sits at 31s forever
//     until we hit freezeSeconds when stagnation IS the signal.
//   - stagnantPolls = 2: with INTERVAL_MS=30s, two consecutive non-
//     incrementing polls means ~60s+ of wall clock without a single TUI
//     redraw advancing the counter. A healthy long-running tool-call
//     redraws every second.
const THRESHOLDS: StuckToolCallThresholds = {
  freezeSeconds: 180,
  stagnantPolls: 2,
}

// Poll cadence. Offset 35s so the three pane-readers (channel-monitor 30s,
// channel-health 45s, stuck-input 15s+20s, this one) don't all hit
// capture-pane on the same tick.
const INITIAL_DELAY_MS = 35_000
const INTERVAL_MS = 30_000

const NO_STATE: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

// Session-keyed state map. Only the main session ever has an entry today,
// but the map shape leaves room for sub-agents without an API change.
const watchState = new Map<string, StuckToolCallState>()

function checkSession(label: string, session: string): void {
  const pane = capturePane(session)
  const sig = pane == null ? null : stuckToolCallSignature(pane)

  const prev = watchState.get(session) ?? NO_STATE
  const { recover, next } = decideStuckToolCallRecovery(sig, prev, Date.now(), THRESHOLDS)

  if (next.tag === null) {
    watchState.delete(session)
  } else {
    watchState.set(session, next)
  }

  if (recover) {
    // Audit log requested by Marveen 2026-06-02: every respawn this watcher
    // decides on must record the input that led to it, so a regression
    // (spurious respawn during legitimate long work) is easy to spot.
    logger.warn(
      {
        label,
        session,
        tag: next.tag,
        seconds: next.lastSeconds,
        stagnantPolls: next.stagnantPolls,
        thresholds: THRESHOLDS,
      },
      'stuck-tool-call-watcher: TUI counter stagnant past freeze threshold, hard-restarting main channels session',
    )
    const result = hardRestartMarveenChannels()
    if (!result.ok) {
      logger.error({ label, session, error: result.error }, 'stuck-tool-call-watcher: hard restart failed')
    }
  }
}

export function startStuckToolCallWatcher(): NodeJS.Timeout {
  function sweep() {
    try {
      checkSession('main', MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'stuck-tool-call-watcher: main session check error')
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
