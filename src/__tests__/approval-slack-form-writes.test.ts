// The form encoding of slackCaller applies to EVERY Web API call the approval module makes, the write methods
// included, not only the reads (conversations.replies, users.info) that motivated it. These tests drive the module's
// real write paths through the real slackCaller with a recording fetch and check what goes over the wire:
//   - postReactionPrompt -> postApprovalPrompt: auth.test, then chat.postMessage with the request text
//   - decide(): the thread notice and the decision feedback, both chat.postMessage with thread_ts
// What the module sends today: chat.postMessage only (no chat.update), and no `blocks` field on any call. That is pinned
// below, so a later change that adds blocks or an edit path has to come through these tests. Because a future
// blocks/chat.update call would go through the same caller, the caller's contract for both is tested too: `blocks` goes
// as ONE form field holding the JSON text of the array, which parses back to exactly the array that was passed.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createApproval, recordApprovalSlackPost, type Approval } from '../db.js'
import { reactionRoute, postReactionPrompt, decide, type RouteDeps } from '../web/approval-slack-route.js'
import { slackCaller, slackEscape, type SlackCall, type ApprovalSlackPost } from '../approval-slack.js'

const OWNER = 'U0OWNER01'
const BOT = 'U0BOTUSR1'
const DM = 'D0DMCHAN1'
const POST_TS = '1700000000.000100'

interface Sent { method: string; headers: Record<string, string>; body: string }

/** A fetch that records every request and answers per method like Slack would. */
function recordingFetch(sent: Sent[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const method = String(url).replace('https://slack.com/api/', '')
    sent.push({ method, headers: init.headers as Record<string, string>, body: String(init.body) })
    let json: Record<string, unknown> = { ok: true }
    if (method === 'auth.test') json = { ok: true, user_id: BOT }
    if (method === 'chat.postMessage') {
      const text = new URLSearchParams(String(init.body)).get('text') ?? ''
      json = { ok: true, ts: POST_TS, message: { text } }
    }
    return new Response(JSON.stringify(json), { status: 200 })
  }) as unknown as typeof fetch
}

/**
 * The wire contract of one request: form encoded, every field a string in the form, no JSON body. Returns the fields.
 * Throws (a failed expect) on the old JSON shape -- the negative control below runs it against that shape.
 */
function formFields(s: Sent): Record<string, string> {
  expect(s.headers['Content-Type']).toMatch(/^application\/x-www-form-urlencoded/)
  expect(s.body.trimStart().startsWith('{')).toBe(false)
  expect(() => JSON.parse(s.body)).toThrow()
  return Object.fromEntries(new URLSearchParams(s.body))
}

function deps(): RouteDeps {
  const s: Record<string, string> = { APPROVAL_SLACK_REACTIONS: 'off', APPROVAL_SLACK_REPLIES: 'on', SLACK_OWNER_USER_ID: OWNER }
  return { setting: (k) => s[k] ?? '', token: () => 'xoxb-test', ownerTarget: async () => DM, verdict: async () => 'ok', drift: async () => false, chunk: 3500 }
}

let n = 0
function request(): Approval {
  return createApproval({
    id: `appr-form-${n++}`, agent_id: 'agent-x', category: 'deploy',
    action_description: 'Deploy <prod> & restart\nsecond line, ékezet',
    timeout_at: Math.floor(Date.now() / 1000) + 3600,
  })
}

function storedPost(approvalId: string): ApprovalSlackPost {
  const post: ApprovalSlackPost = { approvalId, channel: DM, ts: POST_TS, textSha256: 'h', ownerUserId: OWNER, botUserId: BOT, replyMode: true, reactionMode: false }
  recordApprovalSlackPost({ ...post, contentBasis: 'description', reactionMode: false, replyMode: true, lang: 'hu' })
  return post
}

beforeEach(() => { initDatabase(':memory:') })

describe('the approval prompt post (chat.postMessage) goes as form fields', () => {
  it('postReactionPrompt: every call is form encoded; chat.postMessage carries channel/text/unfurl_* as strings, no blocks', async () => {
    const a = request()
    const route = await reactionRoute(a, false, deps(), 'x', 'u')
    if (!route.ok) throw new Error(route.reason)
    const sent: Sent[] = []
    expect(await postReactionPrompt(a, route, slackCaller('xoxb-test', recordingFetch(sent)))).toBe(true)

    expect(sent.map((s) => s.method)).toEqual(['auth.test', 'chat.postMessage'])
    for (const s of sent) formFields(s)
    const post = formFields(sent[1])
    expect(post).toEqual({ channel: DM, text: slackEscape(route.text), unfurl_links: 'false', unfurl_media: 'false' })
    // The escaped text survives the form round trip byte for byte (newlines, accents, &amp; &lt; &gt;).
    expect(post.text).toContain('&lt;prod&gt; &amp; restart\nsecond line, ékezet')
    expect('blocks' in post).toBe(false)
  })
})

describe('the decision thread posts (chat.postMessage with thread_ts) go as form fields', () => {
  it('the edited-reply notice: channel, thread_ts and text as strings', async () => {
    const a = request()
    const post = storedPost(a.id)
    const sent: Sent[] = []
    await decide(slackCaller('xoxb-test', recordingFetch(sent)), post, { kind: 'notice', reason: 'owner_edited' }, () => {})
    expect(sent.map((s) => s.method)).toEqual(['chat.postMessage'])
    const f = formFields(sent[0])
    expect(Object.keys(f).sort()).toEqual(['channel', 'text', 'thread_ts'])
    expect([f.channel, f.thread_ts]).toEqual([DM, POST_TS])
    expect(f.text.length).toBeGreaterThan(0)
  })

  it('the decision feedback after an approval: channel, thread_ts and text as strings, no blocks', async () => {
    const a = request()
    const post = storedPost(a.id)
    const sent: Sent[] = []
    await decide(slackCaller('xoxb-test', recordingFetch(sent)), post, { kind: 'approved', userId: OWNER, via: { binding: 'thread', ts: '1700000001.000200' } }, () => {})
    expect(sent.map((s) => s.method)).toEqual(['chat.postMessage'])
    const f = formFields(sent[0])
    expect(Object.keys(f).sort()).toEqual(['channel', 'text', 'thread_ts'])
    expect([f.channel, f.thread_ts]).toEqual([DM, POST_TS])
  })
})

// The approval module does not send blocks and does not call chat.update today (pinned by the method lists above). The
// caller is shared, so the shape any blocks post or edit would take is fixed here, on the real slackCaller.
const BLOCKS = [
  { type: 'section', text: { type: 'mrkdwn', text: '*Request* & <details>\nsecond line, ékezet' } },
  { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Approve' }, value: 'approve:1', action_id: 'a1' }] },
]

describe('slackCaller: blocks on chat.postMessage and chat.update', () => {
  it.each(['chat.postMessage', 'chat.update'])('%s: blocks is one form field whose JSON parses back to the same array', async (method) => {
    const sent: Sent[] = []
    const call: SlackCall = slackCaller('xoxb-test', recordingFetch(sent))
    const args: Record<string, unknown> = { channel: DM, text: 'fallback text', blocks: BLOCKS }
    if (method === 'chat.update') args.ts = POST_TS
    await call(method, args)
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe(method)
    const f = formFields(sent[0])
    expect(new URLSearchParams(sent[0].body).getAll('blocks')).toHaveLength(1)
    expect(typeof f.blocks).toBe('string')
    expect(JSON.parse(f.blocks)).toEqual(BLOCKS)
    expect(f.channel).toBe(DM)
    expect(f.text).toBe('fallback text')
    if (method === 'chat.update') expect(f.ts).toBe(POST_TS)
    // No field is the object-to-string accident ("[object Object]").
    expect(Object.values(f).some((v) => v.includes('[object Object]'))).toBe(false)
  })
})

describe('negative control: the old JSON-body shape fails the same wire check', () => {
  it('a JSON-body request (the caller before this change) is rejected by formFields', () => {
    const old: Sent = {
      method: 'chat.postMessage',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer xoxb-test' },
      body: JSON.stringify({ channel: DM, text: 'x', blocks: BLOCKS }),
    }
    expect(() => formFields(old)).toThrow()
  })

  it('a form request with blocks left as an object (no JSON text) does not parse back to the array', () => {
    const naive = new URLSearchParams({ channel: DM, blocks: String(BLOCKS) }).toString()
    const f = Object.fromEntries(new URLSearchParams(naive))
    expect(() => JSON.parse(f.blocks)).toThrow()
  })
})
