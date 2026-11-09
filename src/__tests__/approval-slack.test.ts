// APPROVALSLACK1030 (2): the owner's Slack reaction as a decision. A fake Slack API stands in for the Web API, so every
// check is shown on its own: only the snapshot owner's ✅/❌ counts, a bot or app user never does, an edited or changed
// message or both reactions are a refusal, a rate limit stops the round with its Retry-After.
import { describe, it, expect } from 'vitest'
import { postApprovalPrompt, checkPost, sweepOnce, slackEscape, sha256, SlackRateLimited, SWEEP_MAX_PER_ROUND, type SlackCall, type ApprovalSlackPost } from '../approval-slack.js'

const OWNER = 'U0OWNER01'
const BOT = 'U0BOTUSR1'
const OTHER = 'U0OTHER01'
const TEXT = 'Címzett: a@example.com\nSzöveg:\n<b>x</b> & y'

interface World {
  message?: Record<string, unknown> | null
  owner?: Record<string, unknown>
  calls: string[]
  rateLimitOn?: string
}

function fake(w: World): SlackCall {
  return async (method, body) => {
    w.calls.push(method)
    if (w.rateLimitOn === method) throw new SlackRateLimited(7)
    switch (method) {
      case 'auth.test': return { ok: true, user_id: BOT }
      case 'conversations.open': return { ok: true, channel: { id: 'D0DMCHAN1' } }
      case 'chat.postMessage': return { ok: true, ts: '1700000000.000100', channel: body.channel }
      case 'conversations.history': return { ok: true, messages: w.message ? [w.message] : [] }
      case 'users.info': return { ok: true, user: w.owner ?? { id: OWNER, is_bot: false, is_app_user: false, deleted: false } }
      default: return { ok: false, error: 'unknown_method' }
    }
  }
}

const post: ApprovalSlackPost = {
  approvalId: 'appr-1', channel: 'D0DMCHAN1', ts: '1700000000.000100', textSha256: sha256(slackEscape(TEXT)), ownerUserId: OWNER, botUserId: BOT,
}
const msg = (extra: Record<string, unknown> = {}) => ({ ts: post.ts, user: BOT, text: slackEscape(TEXT), ...extra })
const reacted = (name: string, users: string[]) => ({ reactions: [{ name, users, count: users.length }] })

describe('postApprovalPrompt', () => {
  it('posts ONE escaped message into the owner\'s DM and records channel, ts, the posted text\'s sha256, owner and bot', async () => {
    const w: World = { calls: [] }
    const r = await postApprovalPrompt(fake(w), OWNER, TEXT)
    expect(r).toEqual({ ok: true, post: { channel: 'D0DMCHAN1', ts: '1700000000.000100', textSha256: sha256('Címzett: a@example.com\nSzöveg:\n&lt;b&gt;x&lt;/b&gt; &amp; y'), ownerUserId: OWNER, botUserId: BOT } })
    expect(w.calls).toEqual(['auth.test', 'conversations.open', 'chat.postMessage'])
  })

  it('a malformed owner id is refused before any call', async () => {
    const w: World = { calls: [] }
    expect(await postApprovalPrompt(fake(w), 'not-an-id', TEXT)).toEqual({ ok: false, error: 'bad_owner_id' })
    expect(w.calls).toEqual([])
  })
})

describe('checkPost: only the owner\'s reaction on the unchanged message', () => {
  it('no reaction yet: none, and the owner is not looked up', async () => {
    const w: World = { message: msg(), calls: [] }
    expect(await checkPost(fake(w), post)).toEqual({ kind: 'none' })
    expect(w.calls).toEqual(['conversations.history'])
  })

  it('the owner\'s ✅ approves, ❌ rejects', async () => {
    expect(await checkPost(fake({ message: msg(reacted('white_check_mark', [OWNER])), calls: [] }), post)).toEqual({ kind: 'approved', userId: OWNER })
    expect(await checkPost(fake({ message: msg(reacted('x', [OWNER])), calls: [] }), post)).toEqual({ kind: 'rejected', userId: OWNER })
  })

  it('anyone else\'s reaction, the bot\'s included, does nothing', async () => {
    expect(await checkPost(fake({ message: msg(reacted('white_check_mark', [BOT, OTHER])), calls: [] }), post)).toEqual({ kind: 'none' })
    expect(await checkPost(fake({ message: msg(reacted('thumbsup', [OWNER])), calls: [] }), post)).toEqual({ kind: 'none' })
  })

  it('both ✅ and ❌ from the owner: refused, never approved', async () => {
    const m = msg({ reactions: [{ name: 'white_check_mark', users: [OWNER] }, { name: 'x', users: [OWNER] }] })
    expect(await checkPost(fake({ message: m, calls: [] }), post)).toEqual({ kind: 'refused', reason: 'both_reactions' })
  })

  it('an edited, rewritten, foreign or missing message: refused', async () => {
    const yes = reacted('white_check_mark', [OWNER])
    expect(await checkPost(fake({ message: msg({ ...yes, edited: { user: BOT, ts: '1' } }), calls: [] }), post)).toEqual({ kind: 'refused', reason: 'message_edited' })
    expect(await checkPost(fake({ message: msg({ ...yes, text: 'Ártalmatlan szöveg' }), calls: [] }), post)).toEqual({ kind: 'refused', reason: 'message_changed' })
    expect(await checkPost(fake({ message: msg({ ...yes, user: OTHER }), calls: [] }), post)).toEqual({ kind: 'refused', reason: 'message_sender' })
    expect(await checkPost(fake({ message: null, calls: [] }), post)).toEqual({ kind: 'refused', reason: 'message_missing' })
    expect(await checkPost(fake({ message: msg({ ...yes, ts: '1700000000.000200' }), calls: [] }), post)).toEqual({ kind: 'refused', reason: 'message_missing' })
  })

  it('the snapshot owner is a bot, an app user or deleted: refused (Dani 65920 (3))', async () => {
    const m = msg(reacted('white_check_mark', [OWNER]))
    for (const owner of [{ id: OWNER, is_bot: true }, { id: OWNER, is_app_user: true }, { id: OWNER, deleted: true }]) {
      expect(await checkPost(fake({ message: m, owner, calls: [] }), post)).toEqual({ kind: 'refused', reason: 'owner_not_human' })
    }
    expect(await checkPost(fake({ message: m, owner: { id: OTHER }, calls: [] }), post)).toEqual({ kind: 'refused', reason: 'owner_unknown' })
  })
})

describe('sweepOnce', () => {
  const many = Array.from({ length: SWEEP_MAX_PER_ROUND + 3 }, (_, i) => ({ ...post, approvalId: `a${i}` }))

  it('asks about at most SWEEP_MAX_PER_ROUND posts per round, in the order given', async () => {
    const w: World = { message: msg(), calls: [] }
    const r = await sweepOnce(fake(w), many, () => { throw new Error('no decision expected') })
    expect(r).toEqual({ checked: SWEEP_MAX_PER_ROUND, waitS: 0 })
    expect(w.calls.filter((c) => c === 'conversations.history')).toHaveLength(SWEEP_MAX_PER_ROUND)
  })

  it('a 429 stops the round at once and returns the Retry-After (no avalanche)', async () => {
    const w: World = { message: msg(), calls: [], rateLimitOn: 'conversations.history' }
    expect(await sweepOnce(fake(w), many, () => {})).toEqual({ checked: 0, waitS: 7 })
    expect(w.calls).toEqual(['conversations.history'])
  })

  it('marks every checked post (the rotation key), a failing one too, but not the one a 429 stopped (Dani 66059)', async () => {
    const marked: string[] = []
    await sweepOnce(fake({ message: msg(), calls: [] }), many, () => {}, (p) => marked.push(p.approvalId))
    expect(marked).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
    const failing: SlackCall = async () => { throw new Error('boom') }
    const m2: string[] = []
    expect(await sweepOnce(failing, many.slice(0, 2), () => {}, (p) => m2.push(p.approvalId))).toEqual({ checked: 0, waitS: 0 })
    expect(m2).toEqual(['a0', 'a1'])
    const m3: string[] = []
    await sweepOnce(fake({ message: msg(), calls: [], rateLimitOn: 'conversations.history' }), many, () => {}, (p) => m3.push(p.approvalId))
    expect(m3).toEqual([])
  })

  it('hands each decided post to the caller once', async () => {
    const decided: string[] = []
    await sweepOnce(fake({ message: msg(reacted('x', [OWNER])), calls: [] }), many.slice(0, 2), (p, v) => decided.push(`${p.approvalId}:${v.kind}`))
    expect(decided).toEqual(['a0:rejected', 'a1:rejected'])
  })

  it('postApprovalPrompt with a direct channel never calls conversations.open', async () => {
    const w: World = { calls: [] }
    const r = await postApprovalPrompt(fake(w), OWNER, TEXT, 'D0C74N9SAF6')
    expect(r.ok && r.post.channel).toBe('D0C74N9SAF6')
    expect(w.calls).toEqual(['auth.test', 'chat.postMessage'])
  })
})
