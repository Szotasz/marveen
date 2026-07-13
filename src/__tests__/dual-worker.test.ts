import { describe, it, expect } from 'vitest'
import { classifyPriority, makeWorkerCtx } from '../web/agent-worker.js'
import { SCHEDULE_TICK_MS } from '../web/schedule-runner.js'

// ---------------------------------------------------------------------------
// 1. Message priority routing heuristic
// ---------------------------------------------------------------------------
describe('classifyPriority', () => {
  it('short conversational message -> fast', () => {
    expect(classifyPriority('Mi az idő?')).toBe('fast')
  })

  it('message >= 300 chars -> slow regardless of content', () => {
    const long = 'x'.repeat(300)
    expect(classifyPriority(long)).toBe('slow')
  })

  it('message just under 300 chars without keywords -> fast', () => {
    const short = 'x'.repeat(299)
    expect(classifyPriority(short)).toBe('fast')
  })

  it('"analyze" keyword -> slow', () => {
    expect(classifyPriority('Kérlek analyze ezt a fájlt')).toBe('slow')
  })

  it('"elemezd" keyword -> slow', () => {
    expect(classifyPriority('elemezd a logokat')).toBe('slow')
  })

  it('"keresd" keyword -> slow', () => {
    expect(classifyPriority('keresd meg a hibát')).toBe('slow')
  })

  it('"összefoglaló" keyword -> slow', () => {
    expect(classifyPriority('Adj összefoglaló-t')).toBe('slow')
  })

  it('"search" keyword -> slow', () => {
    expect(classifyPriority('search for the bug')).toBe('slow')
  })

  it('"summary" keyword -> slow', () => {
    expect(classifyPriority('give me a summary')).toBe('slow')
  })

  it('"report" keyword -> slow', () => {
    expect(classifyPriority('generate a report')).toBe('slow')
  })

  it('keyword match is case-insensitive', () => {
    expect(classifyPriority('Please ANALYZE this')).toBe('slow')
    expect(classifyPriority('Write a SUMMARY')).toBe('slow')
  })
})

// ---------------------------------------------------------------------------
// 2. makeWorkerCtx -- correct path derivation
// ---------------------------------------------------------------------------
describe('makeWorkerCtx', () => {
  it('derives configDir and scratchDir from homeDir', () => {
    const ctx = makeWorkerCtx('test-session', '/tmp/test-home')
    expect(ctx.session).toBe('test-session')
    expect(ctx.home).toBe('/tmp/test-home')
    expect(ctx.configDir).toBe('/tmp/test-home/.claude-config')
    expect(ctx.scratchDir).toBe('/tmp/test-home/scratch')
  })

  it('initialises chain as a resolved promise', async () => {
    const ctx = makeWorkerCtx('s', '/tmp/h')
    // A resolved chain should allow the next .then to run immediately.
    let ran = false
    await ctx.chain.then(() => { ran = true })
    expect(ran).toBe(true)
  })

  it('initialises lastStuckAlert to 0', () => {
    const ctx = makeWorkerCtx('s', '/tmp/h')
    expect(ctx.lastStuckAlert).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Per-session chain isolation
// ---------------------------------------------------------------------------
describe('WorkerCtx chain isolation', () => {
  it('slow and fast sessions have independent chains', async () => {
    const slow = makeWorkerCtx('slow', '/tmp/slow')
    const fast = makeWorkerCtx('fast', '/tmp/fast')

    const order: string[] = []

    // Block the slow chain for a tick.
    let resolveSlow!: () => void
    slow.chain = slow.chain.then(() => new Promise<void>(r => { resolveSlow = r }))

    // Queue work on both sessions.
    const slowWork = slow.chain.then(() => { order.push('slow') })
    const fastWork = fast.chain.then(() => { order.push('fast') })

    // Fast chain should resolve without waiting for slow.
    await fastWork
    expect(order).toContain('fast')
    expect(order).not.toContain('slow')

    // Unblock slow.
    resolveSlow()
    await slowWork
    expect(order).toContain('slow')
  })
})

// ---------------------------------------------------------------------------
// 4. Schedule tick interval
// ---------------------------------------------------------------------------
describe('SCHEDULE_TICK_MS', () => {
  it('is 15 seconds (15000 ms)', () => {
    expect(SCHEDULE_TICK_MS).toBe(15_000)
  })
})
