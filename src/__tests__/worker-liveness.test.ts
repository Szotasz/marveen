import { describe, it, expect, vi } from 'vitest'
import {
  decideWorkerLiveness,
  sweepWorkerLiveness,
  tailLines,
  NO_WORKER_LIVENESS_STATE,
  DEATH_PANE_LINES,
  type WorkerLivenessState,
  type WorkerLivenessDeps,
} from '../web/worker-liveness.js'

// WORKERBOOT1. Measured on a live host 2026-07-30: both worker sessions were
// created at 11:42 (the "launched interactive worker session" line only runs
// after a successful tmux new-session) and by 18:00 neither existed, with zero
// log lines in between. This instrument exists to make that window visible --
// so the tests are about WHEN it speaks, not about guessing the cause.

const t0 = 1_700_000_000_000

/** Observation helper: isFirstSweep defaults to false (the steady state). */
function obs(alive: boolean, pane: string | null, nowMs: number, isFirstSweep = false) {
  return { alive, pane, nowMs, isFirstSweep }
}

describe('decideWorkerLiveness', () => {
  it('says nothing while the worker is alive, and starts the lifetime clock', () => {
    const d = decideWorkerLiveness(obs(true, 'x', t0), NO_WORKER_LIVENESS_STATE)
    expect(d.logDeath).toBe(false)
    expect(d.next.firstSeenAtMs).toBe(t0)
    expect(d.next.lastSeenAliveAtMs).toBe(t0)
  })

  it('keeps the ORIGINAL first sighting across later polls (lifetime, not age-since-last-poll)', () => {
    let st: WorkerLivenessState = decideWorkerLiveness(obs(true, 'a', t0), NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness(obs(true, 'b', t0 + 60_000), st).next
    st = decideWorkerLiveness(obs(true, 'c', t0 + 120_000), st).next
    expect(st.firstSeenAtMs).toBe(t0)
    expect(st.lastSeenAliveAtMs).toBe(t0 + 120_000)
  })

  it('logs the death exactly ONCE on the alive -> absent transition', () => {
    const alive = decideWorkerLiveness(obs(true, 'p', t0), NO_WORKER_LIVENESS_STATE)
    const died = decideWorkerLiveness(obs(false, null, t0 + 60_000), alive.next)
    expect(died.logDeath).toBe(true)

    // still gone on the next poll -- must NOT re-log, or a permanently dead
    // worker would fill the log with one line per minute
    const again = decideWorkerLiveness(obs(false, null, t0 + 120_000), died.next)
    expect(again.logDeath).toBe(false)
  })

  it('reports the lifetime from first sighting to last sighting', () => {
    let st = decideWorkerLiveness(obs(true, 'p', t0), NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness(obs(true, 'p', t0 + 3 * 3600_000), st).next
    const died = decideWorkerLiveness(obs(false, null, t0 + 3 * 3600_000 + 60_000), st)
    expect(died.lifetimeMs).toBe(3 * 3600_000)
  })

  it('carries the LAST pane seen while alive into the death record', () => {
    let st = decideWorkerLiveness(obs(true, 'first', t0), NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness(obs(true, 'last words', t0 + 60_000), st).next
    const died = decideWorkerLiveness(obs(false, null, t0 + 120_000), st)
    expect(died.lastPane).toBe('last words')
  })

  it('a failed capture does not blank the only evidence we will have', () => {
    let st = decideWorkerLiveness(obs(true, 'good output', t0), NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness(obs(true, null, t0 + 60_000), st).next // capture failed
    const died = decideWorkerLiveness(obs(false, null, t0 + 120_000), st)
    expect(died.lastPane).toBe('good output')
  })

  // The signal is only useful if it stays quiet about non-events.
  it('a session NEVER seen alive is not a death (WEB_ONLY / boot race / never started)', () => {
    const d = decideWorkerLiveness(obs(false, null, t0), NO_WORKER_LIVENESS_STATE)
    expect(d.logDeath).toBe(false)
    expect(d.next).toEqual(NO_WORKER_LIVENESS_STATE)
  })

  it('a restart after a death starts a FRESH lifetime, and can die again', () => {
    let st = decideWorkerLiveness(obs(true, 'p', t0), NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness(obs(false, null, t0 + 60_000), st).next
    st = decideWorkerLiveness(obs(true, 'p2', t0 + 120_000), st).next
    expect(st.firstSeenAtMs).toBe(t0 + 120_000)
    const second = decideWorkerLiveness(obs(false, null, t0 + 180_000), st)
    expect(second.logDeath).toBe(true)
    expect(second.lifetimeMs).toBe(0)
  })
})

describe('tailLines', () => {
  it('keeps the tail, where a crash message would be', () => {
    const pane = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const out = tailLines(pane)!.split('\n')
    expect(out).toHaveLength(DEATH_PANE_LINES)
    expect(out[out.length - 1]).toBe('line 39')
  })
  it('drops blank lines and handles an empty/absent pane', () => {
    expect(tailLines('a\n\n\nb')).toBe('a\nb')
    expect(tailLines(null)).toBeNull()
    expect(tailLines('   \n  ')).toBeNull()
  })
})

describe('sweepWorkerLiveness', () => {
  function deps(over: Partial<WorkerLivenessDeps> = {}): WorkerLivenessDeps {
    return {
      sessions: () => [{ session: 'agent-worker' }, { session: 'agent-worker-fast' }],
      isAlive: () => true,
      capture: () => 'pane',
      onDeath: vi.fn(),
      now: () => t0,
      ...over,
    }
  }

  it('tracks BOTH worker sessions independently', () => {
    const states = new Map()
    const onDeath = vi.fn()
    let alive = true
    const d = deps({ isAlive: (s) => (s === 'agent-worker' ? alive : true), onDeath })
    sweepWorkerLiveness(d, states)   // both alive
    alive = false
    sweepWorkerLiveness(d, states)   // only the slow one died
    expect(onDeath).toHaveBeenCalledTimes(1)
    expect(onDeath.mock.calls[0]![0].session).toBe('agent-worker')
  })

  it('does not capture the pane of a session it already knows is gone', () => {
    const capture = vi.fn(() => 'pane')
    const d = deps({ isAlive: () => false, capture })
    sweepWorkerLiveness(d, new Map())
    expect(capture).not.toHaveBeenCalled()
  })

  it('passes the lifetime and the last pane through to the sink', () => {
    const states = new Map()
    const onDeath = vi.fn()
    let alive = true
    let now = t0
    const d = deps({ isAlive: () => alive, capture: () => 'dying words', onDeath, now: () => now })
    sweepWorkerLiveness(d, states)
    now = t0 + 600_000
    sweepWorkerLiveness(d, states)
    alive = false
    now = t0 + 660_000
    sweepWorkerLiveness(d, states)
    const call = onDeath.mock.calls[0]![0]
    expect(call.lifetimeMs).toBe(600_000)
    expect(call.lastPane).toBe('dying words')
  })
})

// A dashboard restart (deploy, promote, watchdog) empties the state while the
// tmux session survives, because startWorkerSession() is idempotent. Without a
// marker the first sweep would record "first seen now" for a session that may
// already be hours old, and a later death would report a truncated lifetime --
// which reads as a fast death and points at the launch line. The instrument
// would then mislead exactly the investigation it exists to serve.
describe('lifetime after a monitor restart is reported as a LOWER BOUND', () => {
  it('flags a session that was already alive on the first sweep', () => {
    const seen = decideWorkerLiveness(obs(true, 'p', t0, true), NO_WORKER_LIVENESS_STATE)
    expect(seen.next.firstSeenOnFirstSweep).toBe(true)
    const died = decideWorkerLiveness(obs(false, null, t0 + 600_000), seen.next)
    expect(died.logDeath).toBe(true)
    expect(died.lifetimeTruncated).toBe(true)
  })

  it('does NOT flag a session that appeared after the monitor was already running', () => {
    // first sweep: nothing there yet
    const empty = decideWorkerLiveness(obs(false, null, t0, true), NO_WORKER_LIVENESS_STATE)
    // later sweep: the session shows up -- its whole life is observed
    const seen = decideWorkerLiveness(obs(true, 'p', t0 + 60_000), empty.next)
    expect(seen.next.firstSeenOnFirstSweep).toBe(false)
    const died = decideWorkerLiveness(obs(false, null, t0 + 120_000), seen.next)
    expect(died.lifetimeTruncated).toBe(false)
    expect(died.lifetimeMs).toBe(0)
  })

  it('a restart AFTER a first-sweep death starts a clean, untruncated lifetime', () => {
    let st = decideWorkerLiveness(obs(true, 'p', t0, true), NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness(obs(false, null, t0 + 60_000), st).next   // truncated death
    st = decideWorkerLiveness(obs(true, 'p2', t0 + 120_000), st).next   // fresh session, observed from birth
    expect(st.firstSeenOnFirstSweep).toBe(false)
    const second = decideWorkerLiveness(obs(false, null, t0 + 180_000), st)
    expect(second.lifetimeTruncated).toBe(false)
  })

  it('the sweep marks only its FIRST pass, not every pass', () => {
    const states = new Map()
    const onDeath = vi.fn()
    let alive = true
    const d: WorkerLivenessDeps = {
      sessions: () => [{ session: 'w' }],
      isAlive: () => alive,
      capture: () => 'pane',
      onDeath,
      now: () => t0,
    }
    sweepWorkerLiveness(d, states, true)    // first sweep: session already there
    sweepWorkerLiveness(d, states, false)
    alive = false
    sweepWorkerLiveness(d, states, false)
    expect(onDeath.mock.calls[0]![0].lifetimeTruncated).toBe(true)
  })
})
