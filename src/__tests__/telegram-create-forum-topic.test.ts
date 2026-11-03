// createTelegramForumTopic: the one Telegram call that needs the Bot API's
// `result` back (the new topic's message_thread_id). telegramHttpPost now
// resolves with it; every other caller ignores the value.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const httpsRequest = vi.fn()
vi.mock('node:https', () => ({ default: { request: (...a: unknown[]) => httpsRequest(...a) } }))

const { createTelegramForumTopic, getProvider } = await import('../channel-provider.js')

class FakeRequest extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
  destroy = vi.fn((err?: Error) => { if (err) this.emit('error', err) })
}

function respond(statusCode: number, body: string): void {
  const cb = httpsRequest.mock.calls[0][2] as (res: unknown) => void
  const res = Object.assign(new EventEmitter(), { statusCode, resume: () => {} })
  cb(res)
  queueMicrotask(() => {
    res.emit('data', Buffer.from(body))
    res.emit('end')
  })
}

describe('createTelegramForumTopic', () => {
  let req: FakeRequest

  beforeEach(() => {
    req = new FakeRequest()
    httpsRequest.mockImplementation(() => req)
  })
  afterEach(() => { httpsRequest.mockReset() })

  it('posts chat_id + name to createForumTopic and returns the message_thread_id', async () => {
    const pending = createTelegramForumTopic('tok', '42', 'Napi hírek')
    expect(String(httpsRequest.mock.calls[0][0])).toMatch(/\/createForumTopic$/)
    expect(JSON.parse(req.write.mock.calls[0][0] as string)).toEqual({ chat_id: '42', name: 'Napi hírek' })
    respond(200, '{"ok":true,"result":{"message_thread_id":22200,"name":"Napi hírek","icon_color":7322096}}')
    await expect(pending).resolves.toBe(22200)
  })

  it('an answer without a usable message_thread_id is an error, not a topic', async () => {
    const pending = createTelegramForumTopic('tok', '42', 'x')
    respond(200, '{"ok":true,"result":{}}')
    await expect(pending).rejects.toThrow(/returned no message_thread_id/)
  })

  it('ok:false keeps the classifiable "Telegram API <code>" shape', async () => {
    const pending = createTelegramForumTopic('tok', '42', 'x')
    respond(200, '{"ok":false,"error_code":400,"description":"Bad Request: the chat is not a forum"}')
    await expect(pending).rejects.toThrow(/Telegram API 400: ok:false Bad Request: the chat is not a forum/)
  })

  it('sendMessage still resolves to its receipt only (the raw result is not leaked to its callers)', async () => {
    const pending = getProvider('telegram').sendMessage('tok', '1', 'hi')
    respond(200, '{"ok":true,"result":{"message_id":7,"chat":{"id":1}}}')
    await expect(pending).resolves.toStrictEqual({ status: 200, messageId: '7' })
  })
})
