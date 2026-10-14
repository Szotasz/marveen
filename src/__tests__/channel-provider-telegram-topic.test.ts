// The Telegram provider's sendMessage and a topic (TELEGRAM_TOPICS_ENABLED):
// the topic reaches the Bot API body through the test-run marking wrapper,
// and without one the body is exactly what it was before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// `import https from 'node:https'` -> the mock must provide `default`.
const httpsRequest = vi.fn()
vi.mock('node:https', () => ({ default: { request: (...a: unknown[]) => httpsRequest(...a) } }))

const { getProvider } = await import('../channel-provider.js')
const { markIfTestRun } = await import('../test-run-marker.js')
// Under the test runner the wrapper marks every outbound text; compare to that.
const HI = markIfTestRun('hi')

class FakeRequest extends EventEmitter {
  write = vi.fn()
  end = vi.fn()
  destroy = vi.fn()
}

describe('telegram sendMessage body', () => {
  let req: FakeRequest

  beforeEach(() => {
    req = new FakeRequest()
    httpsRequest.mockImplementation(() => req)
  })
  afterEach(() => httpsRequest.mockReset())

  async function body(send: () => Promise<void>): Promise<unknown> {
    const pending = send()
    const cb = httpsRequest.mock.calls[0][2] as (res: EventEmitter & { statusCode: number; resume: () => void }) => void
    const res = Object.assign(new EventEmitter(), { statusCode: 200, resume: () => {} })
    cb(res)
    res.emit('data', Buffer.from('{"ok":true}'))
    res.emit('end')
    await pending
    return JSON.parse(String(req.write.mock.calls[0][0]))
  }

  it('no topic: exactly chat_id and text (and parse_mode when asked)', async () => {
    expect(await body(() => getProvider('telegram').sendMessage('tok', '1', 'hi'))).toEqual({ chat_id: '1', text: HI })
  })

  it('no topic, HTML: parse_mode only', async () => {
    expect(await body(() => getProvider('telegram').sendMessage('tok', '1', 'hi', 'HTML'))).toEqual({ chat_id: '1', text: HI, parse_mode: 'HTML' })
  })

  it('a topic: message_thread_id as a number, through the wrapper', async () => {
    expect(await body(() => getProvider('telegram').sendMessage('tok', '1', 'hi', undefined, '12'))).toEqual({ chat_id: '1', text: HI, message_thread_id: 12 })
  })
})
