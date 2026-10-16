// deliverWhenReady, the backoff that gets a restarted agent its
// first prompt within ~20-30 s instead of waiting for a 300 s sweep or a fixed
// 90 s timer.
//
// The invariant that matters is the NEGATIVE one: while the pane is not ready,
// nothing is typed. So the tests drive a fake clock against a pane that turns
// ready at a known second and assert both when the send happens and that no
// send happened before.

import { describe, it, expect, vi } from 'vitest'
import {
  deliverWhenReady,
  RESUME_DELIVERY_OPTIONS,
  type DeliverDeps,
  type DeliverySendOutcome,
} from '../web/resume-delivery.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
import { logger } from '../logger.js'

/** A fake world: the clock only moves when the loop sleeps. */
function world(readyAtMs: number, outcomes: DeliverySendOutcome[] = ['sent']) {
  let t = 0
  const looks: number[] = []
  const sends: number[] = []
  const deps: DeliverDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms },
    isReady: async () => { looks.push(t); return t >= readyAtMs },
    send: async () => { sends.push(t); return outcomes[Math.min(sends.length - 1, outcomes.length - 1)]! },
  }
  return { deps, looks, sends, at: () => t }
}

const run = (w: ReturnType<typeof world>, extra: Partial<DeliverDeps> = {}) =>
  deliverWhenReady('devy', 'agent-devy', 'resume', RESUME_DELIVERY_OPTIONS, { ...w.deps, ...extra })

describe('deliverWhenReady timing', () => {
  it('pane ready at 11 s -> exactly one send, at the first look (25 s)', async () => {
    const w = world(11_000)
    const res = await run(w)
    expect(res).toMatchObject({ status: 'sent', attempts: 1 })
    expect(w.sends).toEqual([25_000])
  })

  it('looks at 25 s, then every 10 / 20 / 30 s, the last step repeating', async () => {
    const w = world(Infinity)
    await run(w)
    expect(w.looks.slice(0, 7)).toEqual([25_000, 35_000, 55_000, 85_000, 115_000, 145_000, 175_000])
  })

  it('the first look has slack past the identity /rename maximum (20.0 s)', () => {
    expect(RESUME_DELIVERY_OPTIONS.firstMs).toBeGreaterThan(20_000)
  })

  it('never sends before the pane is ready, and is at most one step late', async () => {
    // Replay over a spread of ready times, the measured 11-13 s up to a slow minute.
    for (const readyAt of [5_000, 10_900, 13_100, 25_000, 45_000, 59_000, 100_000]) {
      const w = world(readyAt)
      const res = await run(w)
      expect(res.status).toBe('sent')
      expect(w.sends).toHaveLength(1)
      expect(w.sends[0]!).toBeGreaterThanOrEqual(readyAt)
      expect(w.sends[0]! - readyAt).toBeLessThanOrEqual(30_000)
    }
  })
})

describe('deliverWhenReady busy panes', () => {
  it('a pane that is never ready gets ZERO sends, a WARN and a deadline result', async () => {
    const w = world(Infinity)
    const res = await run(w)
    expect(w.sends).toEqual([])
    expect(res.status).toBe('deadline')
    expect(res.elapsedMs).toBe(RESUME_DELIVERY_OPTIONS.deadlineMs)
    expect(logger.warn).toHaveBeenCalled()
    // ~40 captures over 20 minutes, not a tight loop.
    expect(w.looks.length).toBeLessThanOrEqual(45)
  })

  it("'aborted-busy' keeps the loop going and the second ready moment sends", async () => {
    const w = world(0, ['aborted-busy', 'skipped-locked', 'sent'])
    const res = await run(w)
    expect(res).toMatchObject({ status: 'sent', attempts: 3 })
    expect(w.sends).toEqual([25_000, 35_000, 55_000])
  })

  it('a probe that throws counts as not ready', async () => {
    const w = world(0)
    const res = await run(w, { isReady: async () => { throw new Error('tmux gone') } })
    expect(res.status).toBe('deadline')
    expect(w.sends).toEqual([])
  })

  it('MUTANT: a delivery that skips the readiness probe types into the busy stretch', async () => {
    // The pinned claim "busy -> 0 sends" only means something if removing the
    // probe breaks it. This is that removal, run against the same pane.
    const w = world(60_000)
    await run(w, { isReady: async () => true })
    expect(w.sends[0]!).toBeLessThan(60_000) // typed 40 s before the pane was ready
    const real = world(60_000)
    await run(real)
    expect(real.sends[0]!).toBeGreaterThanOrEqual(60_000)
  })
})

describe('deliverWhenReady ownership', () => {
  it('withdraws without a send once the obligation is gone', async () => {
    const w = world(0)
    let owed = true
    const res = await run(w, {
      stillOwed: () => owed,
      isReady: async () => { owed = false; return true }, // settled while the probe ran
    })
    expect(res.status).toBe('withdrawn')
    expect(w.sends).toEqual([])
  })

  it('does not retry a send that threw (part of the text may have landed)', async () => {
    const w = world(0)
    const send = vi.fn(async () => { throw new Error('tmux') })
    const res = await run(w, { send })
    expect(res.status).toBe('error')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a text builder returning null ends quietly with nothing typed', async () => {
    const w = world(0)
    const res = await deliverWhenReady('devy', 'agent-devy', () => null, RESUME_DELIVERY_OPTIONS, w.deps)
    expect(res.status).toBe('nothing-to-say')
    expect(w.sends).toEqual([])
  })
})
