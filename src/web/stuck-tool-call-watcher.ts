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
// reached freezeSeconds, the tool-call is wedged. Recovery (#248 fix) is the
// respawn-pane path resumeMarveenSession() -- NOT the launchctl hard-restart.
// `tmux respawn-pane -k` replaces only the pane's claude process: it does NOT
// `tmux kill-session`, so an attached client is never kicked ([exited], the
// #248 user-visible crash), and it runs the pane-attribution detached-claude
// reap first (breaking the orphan->409->freeze doom-loop the env-grep reap on
// the launchctl/channels.sh path never cleaned). A CPU-profile guard skips the
// recovery unless the process matches the idle stdio-wedge profile.
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

import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { resolveFromPath } from '../platform.js'
import { capturePane } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { resumeMarveenSession, lastMainRespawnAt, MARVEEN_POST_RESPAWN_GRACE_MS } from './channel-monitor.js'
import {
  stuckToolCallSignature,
  decideStuckToolCallRecovery,
  detectPaneState,
  type StuckToolCallState,
  type StuckToolCallThresholds,
} from '../pane-state.js'

const TMUX = resolveFromPath('tmux')

// CPU-profile guard (#248): the genuine wedge is a render loop blocked on stdio
// -- CPU collapses to ~0.3% (IO-wait). A frozen "Worked for Ns" counter on a
// process that is STILL BURNING CPU is not that wedge: it is a session doing
// heavy synchronous work that just hasn't yielded to a TUI redraw. Only recover
// when the process matches the idle wedge profile (CPU <= maxCpuPercent).
// Fail-open: a null sample (ps failed) does NOT block recovery -- the
// counter-stagnation signal stands on its own.
const WEDGE_MAX_CPU_PERCENT = 30

// Pure: does the sampled CPU% match the idle stdio-wedge profile? null (sample
// failed) -> true (fail-open; do not block recovery on a missing sample).
export function confirmsWedgeProfile(cpuPercent: number | null, maxCpuPercent: number): boolean {
  if (cpuPercent === null) return true
  return cpuPercent <= maxCpuPercent
}

// Recent CPU% of the main session's pane-leader claude (claudePid == panePid for
// the main channels session). null on any failure (fail-open). `ps -o %cpu=` is
// a recent decaying average on macOS/Linux -- enough to tell a 0.3% IO-wait
// wedge from a process actively burning CPU.
function sampleMainClaudeCpuPercent(session: string): number | null {
  try {
    const panePid = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf-8' })
      .split('\n')[0]?.trim()
    if (!panePid || !/^\d+$/.test(panePid)) return null
    const out = execFileSync('/bin/ps', ['-o', '%cpu=', '-p', panePid], { timeout: 3000, encoding: 'utf-8' }).trim()
    const cpu = parseFloat(out)
    return Number.isFinite(cpu) ? cpu : null
  } catch {
    return null
  }
}

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
// minPeakSeconds (2026-06-08 fix): the spell's highest observed counter value
// must reach >= this many seconds before recovery can fire. The 2026-06-08
// false-positive loop respawned the session 13 times in 8h on residual TUI
// footers (3-4s every poll, never advancing) left behind by a prior respawn.
// The real 2026-06-02 wedge had climbed to 31s before stalling. 20s sits
// comfortably between the residual band and the real wedge floor.
const THRESHOLDS: StuckToolCallThresholds = {
  freezeSeconds: 180,
  stagnantPolls: 2,
  minPeakSeconds: 20,
}

// Poll cadence. Offset 35s so the three pane-readers (channel-monitor 30s,
// channel-health 45s, stuck-input 15s+20s, this one) don't all hit
// capture-pane on the same tick.
const INITIAL_DELAY_MS = 35_000
const INTERVAL_MS = 30_000

const NO_STATE: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  spellPeakSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

// Session-keyed state map. Only the main session ever has an entry today,
// but the map shape leaves room for sub-agents without an API change.
const watchState = new Map<string, StuckToolCallState>()

// Pure: should a hard-restart be deferred because a respawn (any source --
// this watcher, channel-monitor's cascade, channel-watchdog.sh, or the #264
// stuck-modal-guard) happened within the post-respawn grace? lastRespawnMs is
// lastMainRespawnAt()'s epoch-ms (0 when none recorded).
export function shouldDeferForRecentRespawn(
  lastRespawnMs: number,
  nowMs: number,
  graceMs = MARVEEN_POST_RESPAWN_GRACE_MS,
): boolean {
  return lastRespawnMs > 0 && nowMs - lastRespawnMs < graceMs
}

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
    // Idle-prompt guard (2026-06-22 false-positive loop): the signature only
    // sees a frozen "<verb> for Ns" footer -- it cannot tell an ACTIVELY-wedged
    // tool-call (the 2026-06-02 incident) from the RESIDUAL footer a COMPLETED
    // turn leaves on screen while the session sits idle waiting for its next
    // heartbeat. Both read as a stagnant counter. The discriminator is the input
    // box: a genuine mid-turn wedge has no ready prompt (detectPaneState != idle,
    // the box is replaced by the busy/working indicator), whereas a completed
    // turn's residual sits ABOVE a live `❯` idle prompt. If the pane is idle, the
    // user can interact -- it is not the user-facing freeze this watcher targets
    // -- so respawning is pure churn (this is what drove ~150 spurious respawns/
    // week, each leaving a fresh residual footer that re-armed the loop). Clear
    // the stale spell so the residual stops re-triggering every poll. Fail-open:
    // a null pane (capture failed) does NOT block recovery.
    if (pane != null && detectPaneState(pane) === 'idle') {
      logger.info(
        { label, session, tag: next.tag, seconds: next.lastSeconds, spellPeakSeconds: next.spellPeakSeconds },
        'stuck-tool-call-watcher: counter stagnant but pane is at the idle prompt (residual footer of a completed turn, not a wedge) -- skipping recovery',
      )
      watchState.delete(session)
      return
    }
    // Post-respawn grace: defer if a respawn (this watcher, channel-monitor's
    // cascade, channel-watchdog.sh, or the #264 stuck-modal-guard on Linux)
    // happened within the grace window. Two reasons: (1) a freshly respawned
    // session's TUI counter can read as a fresh "spell" while it is still
    // booting -- re-restarting it would churn; (2) it symmetrizes coordination
    // with every other respawner via the shared lastMainRespawnAt() stamp, so a
    // recent external respawn can't be double-acted here (bounded the worst
    // case to a single overlap; this closes it). A genuine re-wedge is still
    // caught: the stagnation detection (freeze threshold + 2 stagnant polls)
    // restarts the clock, so it fires again once the grace has elapsed.
    const lastRespawn = lastMainRespawnAt()
    if (shouldDeferForRecentRespawn(lastRespawn, Date.now())) {
      logger.info(
        { label, session, sinceRespawnMs: lastRespawn ? Date.now() - lastRespawn : null, graceMs: MARVEEN_POST_RESPAWN_GRACE_MS },
        'stuck-tool-call-watcher: recent respawn within grace, deferring recovery (avoid double-respawn / boot churn)',
      )
      return
    }
    // CPU-profile guard (#248): the genuine wedge is a render loop blocked on
    // stdio (CPU ~0.3%, IO-wait). A counter that froze while the claude is still
    // burning CPU is heavy synchronous work / render starvation, not the wedge
    // -- respawning it is churn. Skip unless the process matches the idle
    // profile. Fail-open on a null sample.
    const cpuPercent = sampleMainClaudeCpuPercent(session)
    if (!confirmsWedgeProfile(cpuPercent, WEDGE_MAX_CPU_PERCENT)) {
      logger.info(
        { label, session, cpuPercent, maxCpuPercent: WEDGE_MAX_CPU_PERCENT, seconds: next.lastSeconds },
        'stuck-tool-call-watcher: counter stagnant but claude is CPU-active (not the idle wedge profile) -- deferring recovery',
      )
      return
    }
    // Audit log requested by Marveen 2026-06-02: every respawn this watcher
    // decides on must record the input that led to it, so a regression
    // (spurious respawn during legitimate long work) is easy to spot.
    logger.warn(
      {
        label,
        session,
        tag: next.tag,
        seconds: next.lastSeconds,
        spellPeakSeconds: next.spellPeakSeconds,
        stagnantPolls: next.stagnantPolls,
        cpuPercent,
        thresholds: THRESHOLDS,
      },
      'stuck-tool-call-watcher: TUI counter stagnant past freeze threshold + idle wedge profile -- recovering main channels session (respawn-pane, no client-kick)',
    )
    // Recover via the respawn-pane path (resumeMarveenSession), NOT the launchctl
    // hard-restart. respawn-pane -k replaces only the pane's claude process: no
    // `tmux kill-session`, so an attached client is never kicked ([exited], the
    // #248 user-visible crash). resumeMarveenSession also runs the
    // pane-attribution detached-claude reap FIRST, breaking the
    // orphan->409->freeze doom-loop that the launchctl/channels.sh env-grep reap
    // never cleaned (the loop's launchctl path never reaped the main orphans).
    const ok = resumeMarveenSession()
    if (!ok) {
      logger.error({ label, session }, 'stuck-tool-call-watcher: respawn-pane recovery failed')
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
