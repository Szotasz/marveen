// The Slack Web API caller sends form fields, never a JSON body: Slack reads JSON only on its write methods, and on a
// live DM conversations.replies answered invalid_arguments and users.info user_not_found to JSON arguments, so a typed
// "mehet" in the request's thread was never seen. The fake fetch records exactly what goes over the wire.
import { describe, it, expect } from 'vitest'
import { slackCaller, slackForm, SlackRateLimited } from '../approval-slack.js'

interface Sent { url: string; headers: Record<string, string>; body: string }

function fakeFetch(sent: Sent[], status = 200, json: Record<string, unknown> = { ok: true }, headers: Record<string, string> = {}): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) })
    return new Response(JSON.stringify(json), { status, headers })
  }) as unknown as typeof fetch
}

describe('slackForm', () => {
  it('keeps strings as is, sends numbers and booleans as their JSON text, drops undefined and null', () => {
    const f = slackForm({ channel: 'D0X', ts: '1700000000.000100', limit: 200, inclusive: true, unfurl_links: false, gone: undefined, none: null })
    expect([...f.entries()]).toEqual([['channel', 'D0X'], ['ts', '1700000000.000100'], ['limit', '200'], ['inclusive', 'true'], ['unfurl_links', 'false']])
  })

  it('encodes text with newlines, accents and link brackets losslessly', () => {
    const text = 'Döntés: mehet & nem\n&lt;x&gt; <http://localhost:3420/#approvals>'
    expect(new URLSearchParams(slackForm({ text }).toString()).get('text')).toBe(text)
  })
})

describe('slackCaller', () => {
  it('posts a read method as a form body, not JSON (the conversations.replies / users.info case)', async () => {
    const sent: Sent[] = []
    const call = slackCaller('xoxb-test', fakeFetch(sent))
    await call('conversations.replies', { channel: 'D0X', ts: '1700000000.000100', limit: 200 })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://slack.com/api/conversations.replies')
    expect(sent[0].headers['Content-Type']).toMatch(/^application\/x-www-form-urlencoded/)
    expect(sent[0].headers.Authorization).toBe('Bearer xoxb-test')
    expect(() => JSON.parse(sent[0].body)).toThrow()
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({ channel: 'D0X', ts: '1700000000.000100', limit: '200' })
  })

  it('returns Slack\'s JSON answer', async () => {
    const call = slackCaller('t', fakeFetch([], 200, { ok: true, user: { id: 'U1' } }))
    expect(await call('users.info', { user: 'U1' })).toEqual({ ok: true, user: { id: 'U1' } })
  })

  it('a non-2xx answer is ok:false with the status', async () => {
    const call = slackCaller('t', fakeFetch([], 500))
    expect(await call('auth.test', {})).toEqual({ ok: false, error: 'http_500' })
  })

  it('a 429 throws SlackRateLimited with its Retry-After', async () => {
    const call = slackCaller('t', fakeFetch([], 429, { ok: false }, { 'retry-after': '7' }))
    await expect(call('conversations.history', { channel: 'D0X' })).rejects.toBeInstanceOf(SlackRateLimited)
    await expect(call('conversations.history', { channel: 'D0X' })).rejects.toMatchObject({ retryAfterS: 7 })
  })
})
