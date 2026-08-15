import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  tryAcquireSessionSendLane,
  withSessionSendLock,
  __resetSessionSendLocks,
} from '../web/session-send-lock.js'

// PANEWRITERS805: after DELIVLOCK805 serialized the sendPromptToSession emit
// span, six in-process writers still hit the same panes with direct tmux
// send-keys OUTSIDE the lane: the /mcp reconnect healer, the plugin-unlock
// healer, the reauth /login sequence, the agent-worker /clear, and the three
// modal dismissals that ran before the lock. Each could splice keystrokes into
// a delivery mid-chunk-stream. These tests pin (a) the sync fail-closed
// acquire primitive the sync writers use, and (b) that every site actually
// routes through a lane acquire.

afterEach(() => {
  __resetSessionSendLocks()
})

describe('tryAcquireSessionSendLane: sync fail-closed acquire', () => {
  it('acquires a free lane and blocks recover-mode callers until released', async () => {
    const release = tryAcquireSessionSendLane('sess', null)
    expect(release).not.toBeNull()
    const during = await withSessionSendLock('sess', null, 'recover', async () => {})
    expect(during.ran).toBe(false)
    release!()
    const after = await withSessionSendLock('sess', null, 'recover', async () => {})
    expect(after.ran).toBe(true)
  })

  it('returns null while an async holder owns the lane (fail-closed, never queues)', async () => {
    let unblock!: () => void
    const wedged = new Promise<void>(res => { unblock = res })
    const holder = withSessionSendLock('sess', null, 'deliver', async () => { await wedged })
    await Promise.resolve()
    expect(tryAcquireSessionSendLane('sess', null)).toBeNull()
    unblock()
    await holder
    expect(tryAcquireSessionSendLane('sess', null)).not.toBeNull()
  })

  it('release is idempotent: a double call cannot hand the lane to a phantom holder', async () => {
    const release = tryAcquireSessionSendLane('sess', null)!
    release()
    release()
    // Lane is free exactly once: one acquire succeeds, a second concurrent one fails.
    const again = tryAcquireSessionSendLane('sess', null)
    expect(again).not.toBeNull()
    expect(tryAcquireSessionSendLane('sess', null)).toBeNull()
    again!()
  })

  it('hands the lane to a queued deliver-mode waiter on release, not to a barger', async () => {
    const release = tryAcquireSessionSendLane('sess', null)!
    const order: string[] = []
    const waiter = withSessionSendLock('sess', null, 'deliver', async () => { order.push('waiter') })
    await Promise.resolve()
    release()
    await waiter
    expect(order).toEqual(['waiter'])
  })

  it('lane keys are host-scoped: a remote lane does not contend with the local one', () => {
    const local = tryAcquireSessionSendLane('sess', null)
    const remote = tryAcquireSessionSendLane('sess', 'vps1')
    expect(local).not.toBeNull()
    expect(remote).not.toBeNull()
    local!(); remote!()
  })
})

describe('every unguarded pane writer routes through the send lane', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf-8')

  it('channel-mcp-reconnect takes the lane for the whole /mcp menu walk and releases in finally', () => {
    const src = read('../web/channel-mcp-reconnect.ts')
    expect(src).toMatch(/tryAcquireSessionSendLane\(session, null\)/)
    expect(src).toMatch(/deferring reconnect \(fail-closed\)/)
    expect(src).toMatch(/finally \{\s*releaseLane\(\)\s*\}/)
  })

  it('channel-plugin-unlock gates the keystroke fire on the lane and reuses its retry ladder', () => {
    const src = read('../web/channel-plugin-unlock.ts')
    expect(src).toMatch(/tryAcquireSessionSendLane\(state\.session, null\)/)
    // Busy lane consumes retriesLeft exactly like the not-idle branch.
    expect(src).toMatch(/pane send lane busy \(delivery in flight\), retrying/)
    expect(src).toMatch(/sendUnlockKeystrokes\(state\.session, state\.provider\)\s*\} finally \{\s*releaseLane\(\)/)
  })

  it('reauth-healer wraps the /login sequence in recover-mode and logs the skip', () => {
    const src = read('../web/reauth-healer.ts')
    expect(src).toMatch(/withSessionSendLock\(session, null, 'recover'/)
    expect(src).toMatch(/\/login send-keys skipped/)
  })

  it('agent-worker runs /clear + prompt-send as ONE deliver-mode span with a held inner send', () => {
    const src = read('../web/agent-worker.ts')
    expect(src).toMatch(/withSessionSendLock\(ctx\.session, null, 'deliver'/)
    const span = src.slice(src.indexOf("withSessionSendLock(ctx.session, null, 'deliver'"))
    const clearIdx = span.indexOf('clearWorkerContext(ctx)')
    const sendIdx = span.indexOf("lockMode: 'held'")
    expect(clearIdx).toBeGreaterThan(-1)
    expect(sendIdx).toBeGreaterThan(clearIdx)
    expect(src).toMatch(/failedOpen/)
  })

  it('the modal dismissals acquire the lane fail-closed, except when the caller already holds it', () => {
    const src = read('../web/agent-process.ts')
    expect(src).toMatch(/releaseDismissLane = tryAcquireSessionSendLane\(session, host\)/)
    expect(src).toMatch(/modal dismissals skipped/)
    // 'held' callers run the dismissals WITHOUT re-acquiring (self-deadlock guard):
    // the held branch must dismiss directly, before any acquire.
    const heldIdx = src.indexOf("if (lockMode === 'held') {\n    await dismissSurveyModalIfPresent")
    expect(heldIdx).toBeGreaterThan(-1)
  })
})
