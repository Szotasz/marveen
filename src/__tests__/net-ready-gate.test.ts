import { describe, it, expect } from 'vitest'
import {
  decideNetGate,
  newNetGateState,
  probeNetwork,
  NET_GATE_MAX_WAIT_MS,
} from '../web/net-ready-gate.js'

// HALOZATELOTT923. Measured 2026-09-22 19:47, after a host restart: the reconcile
// loop started the first three desired agents before the host's DNS answered.
// All three came up with ZERO external MCP servers (strava ENOTFOUND,
// google-drive/gmail npx timeout) and never retried -- the owner saw it as
// "Fabio has no Strava access". These tests pin the gate that holds the burst
// until the network answers, and the fail-open that keeps an offline host from
// being left with no fleet at all.

const T0 = 1_000_000

describe('decideNetGate', () => {
  it('allows the burst as soon as the network answers', () => {
    const s = newNetGateState()
    const d = decideNetGate(s, true, T0)
    expect(d.allow).toBe(true)
    expect(d.reason).toBe('ready')
    expect(s.ready).toBe(true)
  })

  it('defers the burst while DNS is dead, and asks to log exactly once', () => {
    const s = newNetGateState()
    const first = decideNetGate(s, false, T0)
    expect(first.allow).toBe(false)
    expect(first.reason).toBe('waiting')
    expect(first.logWaiting).toBe(true)

    const second = decideNetGate(s, false, T0 + 60_000)
    expect(second.allow).toBe(false)
    expect(second.logWaiting).toBe(false)
    expect(second.waitedMs).toBe(60_000)
  })

  it('releases the burst on the tick the network comes back, and reports the wait', () => {
    const s = newNetGateState()
    decideNetGate(s, false, T0)
    const d = decideNetGate(s, true, T0 + 45_000)
    expect(d.allow).toBe(true)
    expect(d.reason).toBe('ready')
    expect(d.waitedMs).toBe(45_000)
  })

  it('fails open once the wait window has passed, so an offline host still boots its fleet', () => {
    const s = newNetGateState()
    decideNetGate(s, false, T0)
    const justInside = decideNetGate(s, false, T0 + NET_GATE_MAX_WAIT_MS - 1)
    expect(justInside.allow).toBe(false)

    const past = decideNetGate(s, false, T0 + NET_GATE_MAX_WAIT_MS)
    expect(past.allow).toBe(true)
    expect(past.reason).toBe('timed-out')
    // Failing open must NOT latch: a network that appears later is still 'ready',
    // and the next outage gets the full wait window again.
    expect(s.ready).toBe(false)
    expect(decideNetGate(s, true, T0 + NET_GATE_MAX_WAIT_MS + 1).reason).toBe('ready')
  })

  it('latches: after one success it never blocks again, even if the probe fails', () => {
    const s = newNetGateState()
    decideNetGate(s, true, T0)
    const later = decideNetGate(s, false, T0 + 10 * NET_GATE_MAX_WAIT_MS)
    expect(later.allow).toBe(true)
    expect(later.reason).toBe('latched')
  })
})

describe('probeNetwork', () => {
  it('reports false when no canary resolves (deliberate break: the gate must fail closed here)', async () => {
    const dead = 'nonexistent-canary.invalid'
    await expect(probeNetwork([dead], 2000)).resolves.toBe(false)
  })

  it('reports true when a resolvable name is among the canaries', async () => {
    // localhost resolves from /etc/hosts, so this needs no working DNS or egress.
    await expect(probeNetwork(['localhost'], 2000)).resolves.toBe(true)
  })
})
