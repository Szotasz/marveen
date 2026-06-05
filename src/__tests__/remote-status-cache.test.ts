import { describe, it, expect, vi } from 'vitest'
import { RemoteStatusCache } from '../web/remote-status-cache.js'

describe('RemoteStatusCache', () => {
  it('calls the fetcher on a cold miss and caches the value', () => {
    const cache = new RemoteStatusCache<string>(3000)
    const fetch = vi.fn(() => 'running')
    expect(cache.getOrRefresh('a', 1000, fetch)).toBe('running')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('returns the cached value WITHOUT calling the fetcher again within the TTL', () => {
    const cache = new RemoteStatusCache<string>(3000)
    const fetch = vi.fn(() => 'running')
    cache.getOrRefresh('a', 1000, fetch)
    // 2.9s later -> still fresh -> no second ssh call (dashboard never blocks)
    expect(cache.getOrRefresh('a', 3900, fetch)).toBe('running')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the TTL has elapsed', () => {
    const cache = new RemoteStatusCache<string>(3000)
    let n = 0
    const fetch = vi.fn(() => `v${++n}`)
    expect(cache.getOrRefresh('a', 1000, fetch)).toBe('v1')
    expect(cache.getOrRefresh('a', 4001, fetch)).toBe('v2') // 3.001s later -> stale
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keys are independent', () => {
    const cache = new RemoteStatusCache<string>(3000)
    const fetch = vi.fn((k: string) => k)
    expect(cache.getOrRefresh('a', 1000, () => fetch('a'))).toBe('a')
    expect(cache.getOrRefresh('b', 1000, () => fetch('b'))).toBe('b')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not let a fetcher throw escape -- returns last-known on error, or the fallback when cold', () => {
    const cache = new RemoteStatusCache<string>(3000)
    // cold + throwing fetch -> fallback
    const boom = () => { throw new Error('ssh down') }
    expect(cache.getOrRefresh('a', 1000, boom, 'unreachable')).toBe('unreachable')
    // warm it, then a later throwing refresh returns the last-known value
    cache.getOrRefresh('a', 5000, () => 'running')
    expect(cache.getOrRefresh('a', 9001, boom, 'unreachable')).toBe('running')
  })
})
