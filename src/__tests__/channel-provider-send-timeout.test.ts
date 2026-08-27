// Every provider sendMessage must carry a deadline. The scheduler's
// pending-retry alert stamps `alert_sent_at` BEFORE the send and clears it
// only on a thrown error (schedule-runner sendPendingRetryAlert), so a socket
// that never answers would pin the stamp forever and silence that alert for
// good. These tests pin that the deadline is actually wired in -- a timeout
// that is configured but never attached to the request is the exact
// regression this guards against.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

// `import https from 'node:https'` -> the mock must provide `default`.
const httpsRequest = vi.fn()
vi.mock('node:https', () => ({ default: { request: (...a: unknown[]) => httpsRequest(...a) } }))

const { getProvider } = await import('../channel-provider.js')

/** Minimal stand-in for http.ClientRequest: events + the methods the code calls. */
class FakeRequest extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
  destroy = vi.fn((err?: Error) => { if (err) this.emit('error', err) })
}

describe('telegram sendMessage deadline', () => {
  let req: FakeRequest
  let opts: { timeout?: number } | undefined

  beforeEach(() => {
    req = new FakeRequest()
    httpsRequest.mockImplementation((_url: string, o: { timeout?: number }) => { opts = o; return req })
  })
  afterEach(() => { httpsRequest.mockReset(); opts = undefined })

  it('passes the TOOL_TIMEOUTS.telegram deadline to https.request', async () => {
    const pending = getProvider('telegram').sendMessage('tok', '1', 'hi')
    expect(opts?.timeout).toBe(TOOL_TIMEOUTS['telegram'])
    // Let the request "complete" so the promise settles. The sender reads the
    // body since TSOKFALSE827, so the fake response must stream end (a real
    // IncomingMessage always does).
    const cb = httpsRequest.mock.calls[0][2] as (res: EventEmitter & { statusCode: number; resume: () => void }) => void
    const res = Object.assign(new EventEmitter(), { statusCode: 200, resume: () => {} })
    cb(res)
    res.emit('data', Buffer.from('{"ok":true}'))
    res.emit('end')
    await expect(pending).resolves.toBeUndefined()
  })

  it('a socket timeout destroys the request and REJECTS -- never hangs the caller', async () => {
    const pending = getProvider('telegram').sendMessage('tok', '1', 'hi')
    req.emit('timeout')
    expect(req.destroy).toHaveBeenCalledTimes(1)
    await expect(pending).rejects.toThrow(/timed out/)
  })
})

describe('slack / discord sendMessage deadline', () => {
  const realFetch = globalThis.fetch
  let init: RequestInit | undefined

  beforeEach(() => {
    init = undefined
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, i?: RequestInit) => {
      init = i
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = realFetch })

  it('slack: chat.postMessage carries an AbortSignal', async () => {
    await getProvider('slack').sendMessage('xoxb', 'C0000000001', 'hi')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('discord: the channel message POST carries an AbortSignal', async () => {
    await getProvider('discord').sendMessage('tok', '123', 'hi')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('an aborted fetch surfaces as a rejection with no HTTP status (classified transient upstream)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new DOMException('The operation was aborted', 'TimeoutError') }) as typeof fetch
    await expect(getProvider('slack').sendMessage('xoxb', 'C0000000001', 'hi')).rejects.toThrow(/aborted/)
  })
})
