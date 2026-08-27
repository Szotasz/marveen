// TSOKFALSE827: the honest-send contract on the TS Telegram senders.
//
// NOTIFYVAKSWEEP826 closed this on the bash side (success = transport OK AND
// "ok":true, 13/13 senders); the TS side still treated HTTP 200 + {"ok":false}
// as success -- telegramProvider.sendMessage discarded the body entirely and
// sendTelegramMessage only read it for the message_id. The historical logs
// cannot show whether that ever bit us, precisely BECAUSE the senders were
// blind (every observed ok:false rode inside a 4xx error, but a 200-path
// occurrence would have left no trace). These tests pin the closed contract:
// HTTP 200 + ok:false REJECTS, and the error message carries the body's
// error_code in the "Telegram API <code>" shape so classifySendError keeps
// sorting transient/permanent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// `import https from 'node:https'` -> the mock must provide `default`.
const httpsRequest = vi.fn()
vi.mock('node:https', () => ({ default: { request: (...a: unknown[]) => httpsRequest(...a) } }))

const { getProvider } = await import('../channel-provider.js')
const { classifySendError } = await import('../pending-retries.js')
const { sendTelegramMessage, sendTelegramPhoto } = await import('../web/telegram.js')

class FakeRequest extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
  destroy = vi.fn((err?: Error) => { if (err) this.emit('error', err) })
}

/** Fake http.IncomingMessage: statusCode + a body streamed as data/end. */
function fakeResponse(statusCode: number, body: string): EventEmitter & { statusCode: number; resume: () => void } {
  const res = Object.assign(new EventEmitter(), { statusCode, resume: () => {} })
  queueMicrotask(() => {
    if (body.length > 0) res.emit('data', Buffer.from(body))
    res.emit('end')
  })
  return res
}

describe('telegramProvider.sendMessage reads the body it used to discard', () => {
  let req: FakeRequest

  beforeEach(() => {
    req = new FakeRequest()
    httpsRequest.mockImplementation(() => req)
  })
  afterEach(() => { httpsRequest.mockReset() })

  function respond(statusCode: number, body: string): void {
    const cb = httpsRequest.mock.calls[0][2] as (res: unknown) => void
    cb(fakeResponse(statusCode, body))
  }

  it('HTTP 200 + ok:true resolves', async () => {
    const pending = getProvider('telegram').sendMessage('tok', '1', 'hi')
    respond(200, '{"ok":true,"result":{"message_id":7}}')
    await expect(pending).resolves.toBeUndefined()
  })

  it('HTTP 200 + ok:false REJECTS with the error_code in classifiable shape', async () => {
    const pending = getProvider('telegram').sendMessage('tok', '1', 'hi')
    respond(200, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}')
    await expect(pending).rejects.toThrow(/Telegram API 400: ok:false Bad Request: chat not found/)
  })

  it('the ok:false rejection classifies permanent on a 4xx code, transient without one', () => {
    expect(classifySendError('Telegram API 400: ok:false Bad Request: chat not found')).toBe('permanent')
    expect(classifySendError('Telegram API 429: ok:false Too Many Requests')).toBe('transient')
    expect(classifySendError('Telegram API: ok:false something without a code')).toBe('transient')
  })

  it('a malformed body on HTTP 200 stays a success (the message may be delivered)', async () => {
    const pending = getProvider('telegram').sendMessage('tok', '1', 'hi')
    respond(200, 'not json at all')
    await expect(pending).resolves.toBeUndefined()
  })

  it('a non-200 now carries the body in the error, not just the status', async () => {
    const pending = getProvider('telegram').sendMessage('tok', '1', 'hi')
    respond(403, '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked"}')
    await expect(pending).rejects.toThrow(/Telegram API 403: .*bot was blocked/)
  })
})

describe('sendTelegramMessage (web/telegram) closes the same gap', () => {
  const realFetch = globalThis.fetch

  afterEach(() => { globalThis.fetch = realFetch })

  function mockFetch(status: number, body: string): void {
    globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
  }

  it('HTTP 200 + ok:true returns the message_id', async () => {
    mockFetch(200, '{"ok":true,"result":{"message_id":41}}')
    await expect(sendTelegramMessage('tok', '1', 'hi')).resolves.toBe(41)
  })

  it('HTTP 200 + ok:false THROWS in the classifiable shape', async () => {
    mockFetch(200, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}')
    await expect(sendTelegramMessage('tok', '1', 'hi')).rejects.toThrow(/Telegram API 400: ok:false/)
  })

  it('a malformed success body still returns null, never throws', async () => {
    mockFetch(200, 'garbage')
    await expect(sendTelegramMessage('tok', '1', 'hi')).resolves.toBeNull()
  })
})

describe('sendTelegramPhoto checked nothing; now it checks everything', () => {
  const realFetch = globalThis.fetch

  afterEach(() => { globalThis.fetch = realFetch })

  function mockFetch(status: number, body: string): void {
    globalThis.fetch = vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
  }

  it('a 4xx now throws instead of vanishing', async () => {
    mockFetch(404, '{"ok":false,"error_code":404,"description":"Not Found"}')
    await expect(sendTelegramPhoto('tok', '1', import.meta.filename, 'cap')).rejects.toThrow(/Telegram API 404/)
  })

  it('HTTP 200 + ok:false throws too', async () => {
    mockFetch(200, '{"ok":false,"error_code":400,"description":"PHOTO_INVALID_DIMENSIONS"}')
    await expect(sendTelegramPhoto('tok', '1', import.meta.filename, 'cap')).rejects.toThrow(/Telegram API 400: ok:false PHOTO_INVALID_DIMENSIONS/)
  })

  it('HTTP 200 + ok:true resolves', async () => {
    mockFetch(200, '{"ok":true,"result":{}}')
    await expect(sendTelegramPhoto('tok', '1', import.meta.filename, 'cap')).resolves.toBeUndefined()
  })
})
