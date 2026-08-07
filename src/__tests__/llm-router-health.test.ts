import { describe, it, expect, vi } from 'vitest'
import { probeHost, createHealthCache } from '../llm-router/health.js'

// The health gate.
//
// Both GPU hosts are Windows machines that sleep and update, and both firewall
// ICMP -- so the ollama API is the only honest signal (plan section 2). These
// tests are about the two failures that matter: routing to a machine that is
// not there, and paying a four-second timeout for every request while it is
// away.

const answering = () => vi.fn(async () => ({ ok: true }))
const refusing = () => vi.fn(async () => { throw Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' }) })
const hanging = () =>
  vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }),
  ) as any

describe('probing one host', () => {
  it('takes the first address that answers', async () => {
    const fetchImpl = vi.fn(async (url: string) => ({ ok: url.includes('.163') }))
    const result = await probeHost(['http://192.168.2.189:11434', 'http://192.168.2.163:11434'], { fetchImpl })
    expect(result).toMatchObject({ up: true, address: 'http://192.168.2.163:11434' })
  })

  it('stops at the first success instead of probing the rest', async () => {
    const fetchImpl = answering()
    await probeHost(['http://a:1', 'http://b:2'], { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('is down when no address answers, and says what happened', async () => {
    const result = await probeHost(['http://a:1', 'http://b:2'], { fetchImpl: refusing() })
    expect(result.up).toBe(false)
    expect(result.detail).toMatch(/unreachable/)
  })

  it('gives up on a machine that accepts the connection and then says nothing', async () => {
    // A sleeping Windows box does exactly this. Without the timeout the router
    // would hold the request until the caller gave up first.
    const result = await probeHost(['http://a:1'], { fetchImpl: hanging(), timeoutMs: 10 })
    expect(result.up).toBe(false)
    expect(result.detail).toMatch(/timeout/)
  })
})

describe('the cache in front of it', () => {
  it('does not re-probe within the window', async () => {
    const fetchImpl = answering()
    const clock = { t: 1000 }
    const cache = createHealthCache({ fetchImpl, ttlMs: 15_000, now: () => clock.t })

    await cache.get('air903max', ['http://a:1'])
    await cache.get('air903max', ['http://a:1'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('probes again once the window passes', async () => {
    const fetchImpl = answering()
    const clock = { t: 1000 }
    const cache = createHealthCache({ fetchImpl, ttlMs: 15_000, now: () => clock.t })

    await cache.get('air903max', ['http://a:1'])
    clock.t += 15_001
    await cache.get('air903max', ['http://a:1'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('collapses a burst into one probe', async () => {
    // The failure this prevents: ten requests arriving while a machine is
    // asleep, each starting its own four-second timeout.
    const fetchImpl = answering()
    const cache = createHealthCache({ fetchImpl })
    await Promise.all(Array.from({ length: 10 }, () => cache.get('strikex', ['http://a:1'])))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports what it last saw without probing', async () => {
    const cache = createHealthCache({ fetchImpl: answering() })
    await cache.get('air903max', ['http://a:1'])
    expect(cache.peek()).toMatchObject({ air903max: { up: true } })
  })
})
