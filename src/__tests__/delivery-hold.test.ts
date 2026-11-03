// The delivery-hold registry: the router asks, the context-guard answers, and
// every way the answer can be missing means "deliver" (fail-open).
import { describe, it, expect, vi, afterEach } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() },
}))

import { deliveryHoldFor, setDeliveryHoldProbe } from '../web/delivery-hold.js'

afterEach(() => {
  setDeliveryHoldProbe(null)
  warn.mockClear()
})

describe('deliveryHoldFor', () => {
  it('no probe registered (no guard running): nothing is held', () => {
    expect(deliveryHoldFor('dex', 1_000)).toBeNull()
  })

  it('passes the agent and the time to the probe and returns its answer', () => {
    const probe = vi.fn(() => ({ phase: 'await-ready', untilMs: 5_000 }))
    setDeliveryHoldProbe(probe)
    expect(deliveryHoldFor('dex', 1_000)).toEqual({ phase: 'await-ready', untilMs: 5_000 })
    expect(probe).toHaveBeenCalledWith('dex', 1_000)
  })

  it('a probe that throws means "not held", with a warning', () => {
    setDeliveryHoldProbe(() => { throw new Error('boom') })
    expect(deliveryHoldFor('dex', 1_000)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('unregistering the probe ends every hold', () => {
    setDeliveryHoldProbe(() => ({ phase: 'await-handoff', untilMs: 9_000 }))
    setDeliveryHoldProbe(null)
    expect(deliveryHoldFor('dex', 1_000)).toBeNull()
  })
})
