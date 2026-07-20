import { describe, it, expect } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { buildDbImportLockContext, withImportLock, withRetry } from '../costops/collectors/import-durability.js'

describe('withImportLock (CostOps Phase 1, GAP-07 -- per-provider concurrency lock)', () => {
  it('acquires a free lock and runs fn, releasing afterward', async () => {
    initDatabase(':memory:')
    const ctx = buildDbImportLockContext(getDb())
    const res = await withImportLock(ctx, 'openai', 1000, async () => 'done')
    expect(res).toEqual({ ok: true, result: 'done' })
    // released -- a second call for the same provider succeeds too
    const res2 = await withImportLock(ctx, 'openai', 1001, async () => 'done again')
    expect(res2).toEqual({ ok: true, result: 'done again' })
  })

  it('rejects a concurrent call for the same provider while the lock is held (simulated via a slow fn)', async () => {
    initDatabase(':memory:')
    const ctx = buildDbImportLockContext(getDb())
    // Simulate "in flight": acquire directly, don't release yet.
    ctx.tryAcquireLock('openai', 'holder-token', 1000, 10 * 60)
    const res = await withImportLock(ctx, 'openai', 1005, async () => 'should not run')
    expect(res).toEqual({ ok: false, reason: 'locked' })
  })

  it('does not block a DIFFERENT provider while one provider is locked', async () => {
    initDatabase(':memory:')
    const ctx = buildDbImportLockContext(getDb())
    ctx.tryAcquireLock('openai', 'holder-token', 1000, 10 * 60)
    const res = await withImportLock(ctx, 'github', 1005, async () => 'github runs fine')
    expect(res).toEqual({ ok: true, result: 'github runs fine' })
  })

  it('releases the lock even when fn throws, so a failed run does not wedge the provider', async () => {
    initDatabase(':memory:')
    const ctx = buildDbImportLockContext(getDb())
    await expect(withImportLock(ctx, 'openai', 1000, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // lock was released in the finally -- a subsequent call succeeds
    const res = await withImportLock(ctx, 'openai', 1001, async () => 'recovered')
    expect(res).toEqual({ ok: true, result: 'recovered' })
  })

  it('reclaims a stale lock left by a crashed holder instead of wedging forever', async () => {
    initDatabase(':memory:')
    const ctx = buildDbImportLockContext(getDb())
    ctx.tryAcquireLock('openai', 'crashed-holder', 1000, 10 * 60) // never released -- simulates a crash
    // Well within staleAfterSecs -- still held.
    expect(await withImportLock(ctx, 'openai', 1000 + 60, async () => 'x', { staleAfterSecs: 10 * 60 })).toEqual({ ok: false, reason: 'locked' })
    // Past staleAfterSecs -- reclaimable.
    const now = 1000 + 700 // 700s later, past a 600s stale threshold
    const res = await withImportLock(ctx, 'openai', now, async () => 'reclaimed', { staleAfterSecs: 600 })
    expect(res).toEqual({ ok: true, result: 'reclaimed' })
  })

  it('two different lock tokens never both succeed for a genuinely concurrent acquire attempt', () => {
    initDatabase(':memory:')
    const ctx = buildDbImportLockContext(getDb())
    const first = ctx.tryAcquireLock('openai', 'token-a', 1000, 10 * 60)
    const second = ctx.tryAcquireLock('openai', 'token-b', 1000, 10 * 60)
    expect(first).toBe('acquired')
    expect(second).toBe('held')
  })
})

describe('withRetry (CostOps Phase 1, GAP-07 -- transient-error backoff)', () => {
  it('returns the result immediately on first success, no sleep called', async () => {
    const sleeps: number[] = []
    const result = await withRetry(async () => 42, { sleep: async (ms) => { sleeps.push(ms) } })
    expect(result).toBe(42)
    expect(sleeps).toEqual([])
  })

  it('retries with exponential backoff until success', async () => {
    const sleeps: number[] = []
    let attempts = 0
    const result = await withRetry(async () => {
      attempts++
      if (attempts < 3) throw new Error('transient')
      return 'ok'
    }, { maxAttempts: 5, baseDelayMs: 100, sleep: async (ms) => { sleeps.push(ms) } })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([100, 200]) // 100*2^0, 100*2^1
  })

  it('throws the last error after exhausting maxAttempts', async () => {
    let attempts = 0
    await expect(withRetry(async () => { attempts++; throw new Error(`fail ${attempts}`) }, {
      maxAttempts: 3, baseDelayMs: 10, sleep: async () => {},
    })).rejects.toThrow('fail 3')
    expect(attempts).toBe(3)
  })

  it('does not retry a non-retryable error -- throws on first failure', async () => {
    let attempts = 0
    await expect(withRetry(async () => { attempts++; throw new Error('permanent: bad credentials') }, {
      maxAttempts: 5, sleep: async () => {},
      isRetryable: (err) => !(err instanceof Error && err.message.startsWith('permanent')),
    })).rejects.toThrow('permanent')
    expect(attempts).toBe(1)
  })
})
