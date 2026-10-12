// Unit test for `snapshotProcsWithRetry` -- the tiny retry wrapper around the
// liveness `ps -axww` snapshot. The live probe's `ps` normally returns in ~20ms
// but throws on a loaded box when it exceeds the fast-path timeout; a single
// throw used to mean 'unknown' immediately, spamming the log in bursts at load
// peaks (2026-07-14+ clusters). The wrapper retries once with a longer deadline,
// so a transient timeout no longer blinds the watchdog. Only a second failure is
// a genuine "we cannot tell".

import { describe, it, expect, vi } from 'vitest'
import {
  snapshotProcsWithRetry,
  PS_PROBE_TIMEOUT_MS,
  PS_PROBE_RETRY_TIMEOUT_MS,
} from '../channel-coordinator/liveness.js'

describe('snapshotProcsWithRetry', () => {
  it('returns the first attempt without retrying on the fast path', () => {
    const run = vi.fn((_t: number) => 'PS-OUTPUT')
    const out = snapshotProcsWithRetry(run)
    expect(out).toBe('PS-OUTPUT')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(PS_PROBE_TIMEOUT_MS)
  })

  it('retries once with the longer deadline when the fast path throws', () => {
    const run = vi.fn((timeoutMs: number) => {
      if (timeoutMs === PS_PROBE_TIMEOUT_MS) throw new Error('ETIMEDOUT')
      return 'PS-OUTPUT-RETRY'
    })
    const out = snapshotProcsWithRetry(run)
    expect(out).toBe('PS-OUTPUT-RETRY')
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(1, PS_PROBE_TIMEOUT_MS)
    expect(run).toHaveBeenNthCalledWith(2, PS_PROBE_RETRY_TIMEOUT_MS)
  })

  it('propagates the error when BOTH attempts throw (verdict stays unknown upstream)', () => {
    const run = vi.fn((_t: number) => { throw new Error('ETIMEDOUT') })
    expect(() => snapshotProcsWithRetry(run)).toThrow('ETIMEDOUT')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not retry after a successful fast path even if it would have failed later', () => {
    const run = vi.fn((_t: number) => 'OK')
    snapshotProcsWithRetry(run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('uses the retry timeout strictly greater than the fast-path timeout', () => {
    expect(PS_PROBE_RETRY_TIMEOUT_MS).toBeGreaterThan(PS_PROBE_TIMEOUT_MS)
  })
})
