import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  withSessionSendLock,
  __resetSessionSendLocks,
  DEFAULT_DELIVER_WAIT_BUDGET_MS,
} from '../web/session-send-lock.js'

const delay = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))

// DELIVLOCK805 -- the per-pane delivery mutex. These are BEHAVIOURAL tests: the
// first one FAILS if the mutex is reverted to a pass-through (the pre-fix
// logic), because two concurrent chunked writes then interleave -- which is
// exactly the reproduction (foreign text spliced into a trusted-sender frame).
describe('withSessionSendLock -- per-session delivery serialization', () => {
  beforeEach(() => __resetSessionSendLocks())

  it('serializes two concurrent DELIVER writers to the same pane (no interleave)', async () => {
    // Each writer emits three "chunks" with an await between them, mirroring
    // sendPromptToSession's chunk stream (send-keys -l ... await delay ...).
    // Without the lock these interleave (A0,B0,A1,B1,...); with it, one writer
    // fully precedes the other.
    const log: string[] = []
    const writer = (label: string) => async () => {
      for (let i = 0; i < 3; i++) {
        log.push(`${label}${i}`)
        await delay(5)
      }
    }
    await Promise.all([
      withSessionSendLock('sess', null, 'deliver', writer('A')),
      withSessionSendLock('sess', null, 'deliver', writer('B')),
    ])
    // The two messages must not interleave: all of one label's chunks are
    // contiguous. Equivalently, the sequence is either A0A1A2B0B1B2 or the
    // reverse -- never A0B0A1... .
    const joined = log.join('')
    expect(['A0A1A2B0B1B2', 'B0B1B2A0A1A2']).toContain(joined)
  })

  it('DIFFERENT panes are NOT serialized against each other (per-session, not global)', async () => {
    // A long hold on one session must not block delivery to another pane --
    // otherwise one stuck agent would silence the whole fleet.
    const order: string[] = []
    const slow = withSessionSendLock('sessX', null, 'deliver', async () => {
      await delay(40); order.push('X')
    })
    const fast = withSessionSendLock('sessY', null, 'deliver', async () => {
      order.push('Y')
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(['Y', 'X']) // Y finished while X was still held
  })

  it('RECOVER mode skips (ran:false) when a delivery holds the lane, runs when free', async () => {
    let releaseHolder!: () => void
    const held = new Promise<void>(res => { releaseHolder = res })
    // Start a deliver holder that stays in its critical section until released.
    const holder = withSessionSendLock('sess', null, 'deliver', async () => { await held })
    await delay(5) // let the holder acquire

    let recoverRan = false
    const skipped = await withSessionSendLock('sess', null, 'recover', async () => { recoverRan = true })
    expect(skipped.ran).toBe(false)  // fail-closed: did NOT race the live delivery
    expect(recoverRan).toBe(false)

    releaseHolder()
    await holder

    // Lane free now -> recover runs.
    const ran = await withSessionSendLock('sess', null, 'recover', async () => { recoverRan = true })
    expect(ran.ran).toBe(true)
    expect(recoverRan).toBe(true)
  })

  it('DELIVER fails OPEN when the wait budget elapses against a wedged holder', async () => {
    // A holder that never releases must not wedge the delivery path forever:
    // after the budget, the second deliver runs WITHOUT the lock (failedOpen).
    let unblock!: () => void
    const wedged = new Promise<void>(res => { unblock = res })
    const holder = withSessionSendLock('sess', null, 'deliver', async () => { await wedged })
    await delay(5)

    // Injected sleep makes the budget deterministic (no real 60s wait): resolve
    // the "budget" immediately so the timeout wins the race.
    let secondRan = false
    const second = await withSessionSendLock(
      'sess', null, 'deliver',
      async () => { secondRan = true },
      { waitBudgetMs: 1, sleep: () => Promise.resolve() },
    )
    expect(second.ran).toBe(true)
    expect(second.failedOpen).toBe(true) // ran WITHOUT the lock, loudly flagged
    expect(secondRan).toBe(true)

    unblock()
    await holder
  })

  it('a fail-open waiter is removed from the queue so a later release does not resolve a phantom holder', async () => {
    // Regression guard for the splice-out: after a fail-open timeout, releasing
    // the original holder must not "hand off" to the timed-out waiter.
    let unblock!: () => void
    const wedged = new Promise<void>(res => { unblock = res })
    const holder = withSessionSendLock('sess', null, 'deliver', async () => { await wedged })
    await delay(5)
    await withSessionSendLock('sess', null, 'deliver', async () => {}, { waitBudgetMs: 1, sleep: () => Promise.resolve() })
    unblock()
    await holder
    // Lane must now be free: a fresh recover acquires immediately (ran:true).
    const after = await withSessionSendLock('sess', null, 'recover', async () => {})
    expect(after.ran).toBe(true)
    expect(DEFAULT_DELIVER_WAIT_BUDGET_MS).toBeGreaterThan(1000) // real default is generous
  })
})

// Source contract: the byte-emitting span of sendPromptToSession must be run
// UNDER the lock, and the recovery re-inject must use recover-mode. If a future
// edit removes the wrap, these fail.
describe('sendPromptToSession delivery-lock wiring', () => {
  const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
  const CHANNEL_MONITOR = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')

  it('sendPromptToSession runs its emit span inside withSessionSendLock', () => {
    expect(AGENT_PROCESS).toMatch(/await withSessionSendLock\(session, host, lockMode, emitToPane\)/)
    // 'held' short-circuits to a direct emit (no self-deadlock).
    expect(AGENT_PROCESS).toMatch(/if \(lockMode === 'held'\)/)
  })

  it('the stuck-input clear+re-inject recovery uses recover-mode (fail-closed)', () => {
    expect(CHANNEL_MONITOR).toMatch(/withSessionSendLock\(session, null, 'recover'/)
    expect(CHANNEL_MONITOR).toMatch(/lockMode: 'held'/)
  })
})
