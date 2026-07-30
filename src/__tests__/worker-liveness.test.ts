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

describe('decideWorkerLiveness', () => {
  it('says nothing while the worker is alive, and starts the lifetime clock', () => {
    const d = decideWorkerLiveness({ alive: true, pane: 'x', nowMs: t0 }, NO_WORKER_LIVENESS_STATE)
    expect(d.logDeath).toBe(false)
    expect(d.next.firstSeenAtMs).toBe(t0)
    expect(d.next.lastSeenAliveAtMs).toBe(t0)
  })

  it('keeps the ORIGINAL first sighting across later polls (lifetime, not age-since-last-poll)', () => {
    let st: WorkerLivenessState = decideWorkerLiveness({ alive: true, pane: 'a', nowMs: t0 }, NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness({ alive: true, pane: 'b', nowMs: t0 + 60_000 }, st).next
    st = decideWorkerLiveness({ alive: true, pane: 'c', nowMs: t0 + 120_000 }, st).next
    expect(st.firstSeenAtMs).toBe(t0)
    expect(st.lastSeenAliveAtMs).toBe(t0 + 120_000)
  })

  it('logs the death exactly ONCE on the alive -> absent transition', () => {
    const alive = decideWorkerLiveness({ alive: true, pane: 'p', nowMs: t0 }, NO_WORKER_LIVENESS_STATE)
    const died = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 + 60_000 }, alive.next)
    expect(died.logDeath).toBe(true)

    // still gone on the next poll -- must NOT re-log, or a permanently dead
    // worker would fill the log with one line per minute
    const again = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 + 120_000 }, died.next)
    expect(again.logDeath).toBe(false)
  })

  it('reports the lifetime from first sighting to last sighting', () => {
    let st = decideWorkerLiveness({ alive: true, pane: 'p', nowMs: t0 }, NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness({ alive: true, pane: 'p', nowMs: t0 + 3 * 3600_000 }, st).next
    const died = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 + 3 * 3600_000 + 60_000 }, st)
    expect(died.lifetimeMs).toBe(3 * 3600_000)
  })

  it('carries the LAST pane seen while alive into the death record', () => {
    let st = decideWorkerLiveness({ alive: true, pane: 'first', nowMs: t0 }, NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness({ alive: true, pane: 'last words', nowMs: t0 + 60_000 }, st).next
    const died = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 + 120_000 }, st)
    expect(died.lastPane).toBe('last words')
  })

  it('a failed capture does not blank the only evidence we will have', () => {
    let st = decideWorkerLiveness({ alive: true, pane: 'good output', nowMs: t0 }, NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness({ alive: true, pane: null, nowMs: t0 + 60_000 }, st).next // capture failed
    const died = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 + 120_000 }, st)
    expect(died.lastPane).toBe('good output')
  })

  // The signal is only useful if it stays quiet about non-events.
  it('a session NEVER seen alive is not a death (WEB_ONLY / boot race / never started)', () => {
    const d = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 }, NO_WORKER_LIVENESS_STATE)
    expect(d.logDeath).toBe(false)
    expect(d.next).toEqual(NO_WORKER_LIVENESS_STATE)
  })

  it('a restart after a death starts a FRESH lifetime, and can die again', () => {
    let st = decideWorkerLiveness({ alive: true, pane: 'p', nowMs: t0 }, NO_WORKER_LIVENESS_STATE).next
    st = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 + 60_000 }, st).next
    st = decideWorkerLiveness({ alive: true, pane: 'p2', nowMs: t0 + 120_000 }, st).next
    expect(st.firstSeenAtMs).toBe(t0 + 120_000)
    const second = decideWorkerLiveness({ alive: false, pane: null, nowMs: t0 + 180_000 }, st)
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
