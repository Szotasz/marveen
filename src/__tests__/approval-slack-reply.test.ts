// APPROVALSLACK1030 B (the owner's decision of 11-04, Samu 67693): the owner's typed "mehet" / "nem" as a decision, read
// by the server. A fake Slack API stands in for the Web API, so each rule is shown on its own: which request a reply
// belongs to (its thread, or the first message after it with nobody in between), the owner's last word after 30 s, the
// exact words, an edited reply, and the request message itself still being the one the server posted.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({ logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { checkPost, sweepOnce, replyWord, tsCompare, slackEscape, sha256, REPLY_SETTLE_S, type SlackCall, type ApprovalSlackPost } from '../approval-slack.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'

const OWNER = 'U0OWNER01'
const BOT = 'U0BOTUSR1'
const OTHER = 'U0OTHER01'
const TEXT = '[JÓVÁHAGYÁS KELL] samu | deploy\nÉles deploy a connectors-api-ra'
const POST_TS = '1700000000.000100'
const NOW = 1700000000 + 3600

type Msg = Record<string, unknown>
const at = (s: number) => `${1700000000 + s}.000200`
const owner = (text: string, s: number, extra: Msg = {}): Msg => ({ ts: at(s), user: OWNER, text, ...extra })
const bot = (text: string, s: number): Msg => ({ ts: at(s), user: BOT, bot_id: 'B0BOT0001', text })

interface World { parent?: Msg; thread?: Msg[]; after?: Msg[]; hasMore?: boolean; ownerInfo?: Msg; calls: string[] }

function fake(w: World): SlackCall {
  return async (method, body) => {
    w.calls.push(method)
    if (method === 'conversations.history') {
      if (body.latest === POST_TS) return { ok: true, messages: [w.parent ?? parent(w.thread)] }
      // Slack returns the newest first.
      return { ok: true, messages: [...(w.after ?? [])].reverse(), has_more: w.hasMore === true }
    }
    if (method === 'conversations.replies') return { ok: true, messages: [w.parent ?? parent(w.thread), ...(w.thread ?? [])] }
    if (method === 'users.info') return { ok: true, user: w.ownerInfo ?? { id: OWNER, is_bot: false, is_app_user: false, deleted: false } }
    return { ok: false, error: 'unknown_method' }
  }
}

function parent(thread?: Msg[], extra: Msg = {}): Msg {
  return { ts: POST_TS, user: BOT, text: slackEscape(TEXT), reply_count: thread?.length ?? 0, ...extra }
}

const post: ApprovalSlackPost = {
  approvalId: 'appr-1', channel: 'D0DMCHAN1', ts: POST_TS, textSha256: sha256(slackEscape(TEXT)), ownerUserId: OWNER, botUserId: BOT,
  reactionMode: false, replyMode: true,
}

const verdict = (w: Omit<World, 'calls'>, p: ApprovalSlackPost = post, now = NOW) => checkPost(fake({ ...w, calls: [] }), p, now)

describe('which request a reply belongs to', () => {
  it('a "mehet" in the request\'s thread approves it', async () => {
    expect(await verdict({ thread: [owner('mehet', 10)] })).toEqual({ kind: 'approved', userId: OWNER, via: { binding: 'thread', ts: at(10) } })
  })

  it('a "mehet" as the first message after the request approves it, no thread needed', async () => {
    expect(await verdict({ after: [owner('mehet', 10)] })).toEqual({ kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts: at(10) } })
  })

  it('"nem" rejects', async () => {
    expect(await verdict({ after: [owner('nem', 10)] })).toMatchObject({ kind: 'rejected', userId: OWNER })
  })

  it('a "mehet" given to ANOTHER question is not an approval (egm-design B1)', async () => {
    expect(await verdict({ after: [bot('Folytathatom a takarítást?', 5), owner('mehet', 10)] })).toEqual({ kind: 'none' })
  })

  it('after an interjection outside the thread there is no binding', async () => {
    expect(await verdict({ after: [owner('várj', 5), bot('Rendben.', 6), owner('mehet', 10)] })).toEqual({ kind: 'none' })
    expect(await verdict({ after: [{ ts: at(5), user: OTHER, text: 'szia' }, owner('mehet', 10)] })).toEqual({ kind: 'none' })
  })

  it('in the thread, a foreign message before the owner\'s word breaks the binding; the server\'s own notice does not', async () => {
    expect(await verdict({ thread: [bot('Mehetünk?', 5), owner('mehet', 10)] })).toEqual({ kind: 'none' })
    const notice = bot('notice', 5)
    expect(await verdict({ thread: [notice, owner('mehet', 10)] }, { ...post, noticeTs: String(notice.ts) })).toMatchObject({ kind: 'approved' })
  })

  it('once the owner wrote in the thread, the thread decides (a top-level "mehet" does not override a thread "várj")', async () => {
    expect(await verdict({ thread: [owner('várj, megnézem', 5)], after: [owner('mehet', 10)] })).toEqual({ kind: 'none' })
  })

  it('a page with more after the request than one read shows: no binding (the first message is not in sight)', async () => {
    expect(await verdict({ after: [owner('mehet', 10)], hasMore: true })).toEqual({ kind: 'none' })
  })

  it('another user\'s "mehet", or the owner\'s id on a bot/app/subtype message, is not the owner\'s reply', async () => {
    expect(await verdict({ after: [{ ts: at(10), user: OTHER, text: 'mehet' }] })).toEqual({ kind: 'none' })
    for (const extra of [{ bot_id: 'B0X' }, { app_id: 'A0X' }, { subtype: 'thread_broadcast' }]) {
      expect(await verdict({ after: [owner('mehet', 10, extra)] })).toEqual({ kind: 'none' })
    }
  })
})

describe('the owner\'s last word, after the settle time', () => {
  it('"mehet", then "nem, várj" within 30 s: no approval', async () => {
    expect(await verdict({ after: [owner('mehet', 10), owner('nem, várj', 25)] })).toEqual({ kind: 'none' })
    expect(await verdict({ thread: [owner('mehet', 10), owner('nem, várj', 25)] })).toEqual({ kind: 'none' })
  })

  it('a "mehet" younger than REPLY_SETTLE_S waits; older decides', async () => {
    const ts = 1700000000 + 10
    expect(await verdict({ after: [owner('mehet', 10)] }, post, ts + REPLY_SETTLE_S - 1)).toEqual({ kind: 'none', pending: true })
    expect(await verdict({ after: [owner('mehet', 10)] }, post, ts + REPLY_SETTLE_S + 1)).toMatchObject({ kind: 'approved' })
  })

  it('an edited owner message decides nothing; it asks for a notice', async () => {
    expect(await verdict({ after: [owner('mehet', 10, { edited: { user: OWNER, ts: at(12) } })] })).toEqual({ kind: 'notice', reason: 'owner_edited' })
    expect(await verdict({ thread: [owner('mehet', 10, { edited: { user: OWNER, ts: at(12) } })] })).toEqual({ kind: 'notice', reason: 'owner_edited' })
  })
})

describe('the words', () => {
  it('exactly mehet / jóváhagyom approve, nem / elutasítom reject, after NFC and folding; anything else is nothing', () => {
    for (const t of ['mehet', 'Mehet', 'MEHET!', '  mehet. ', 'jóváhagyom', 'jóváhagyom'.normalize('NFD'), 'Jóváhagyom.']) expect(replyWord(t, 'hu'), t).toBe('approved')
    for (const t of ['nem', 'Nem.', 'elutasítom']) expect(replyWord(t, 'hu'), t).toBe('rejected')
    for (const t of ['mehet?', 'igen', 'ok', '*mehet*', 'mehet, de', 'nem, várj', 'mehet mehet', '', 'mehet?!']) expect(replyWord(t, 'hu'), t).toBeNull()
    expect(replyWord(undefined, 'hu')).toBeNull()
  })

  // APPROVALTAGEN1108 (Samu 73344): a Hungarian post's set is UNCHANGED; an English post adds approve/go, reject/no.
  it('a Hungarian post: the English words decide NOTHING (the set did not grow)', () => {
    for (const t of ['approve', 'go', 'Go!', 'reject', 'no', 'No.']) expect(replyWord(t, 'hu'), t).toBeNull()
  })

  it('an English post: approve/go and reject/no decide, the Hungarian words still do; yes/ok and near misses never', () => {
    for (const t of ['approve', 'Approve.', 'go', 'GO!', '  go ', 'mehet', 'jóváhagyom']) expect(replyWord(t, 'en'), t).toBe('approved')
    for (const t of ['reject', 'Reject!', 'no', 'No.', 'nem', 'elutasítom']) expect(replyWord(t, 'en'), t).toBe('rejected')
    for (const t of ['yes', 'ok', 'okay', 'approve?', 'go ahead', 'nope', 'no way', 'approved', 'rejected', 'igen', '*go*', '']) expect(replyWord(t, 'en'), t).toBeNull()
  })

  it('Slack ts order is numeric', () => {
    expect(tsCompare('1700000000.000100', '1700000000.000200')).toBe(-1)
    expect(tsCompare('1700000001.000000', '999999999.999999')).toBe(1)
    expect(tsCompare('1700000000.000100', '1700000000.000100')).toBe(0)
  })
})

describe('the request message must still be the one the server posted, whichever signal decided', () => {
  it('edited, foreign sender, changed text, missing: a refusal (rejection + alert), never an approval', async () => {
    expect(await verdict({ parent: parent([], { edited: { ts: at(1) } }), after: [owner('mehet', 10)] })).toEqual({ kind: 'refused', reason: 'message_edited' })
    expect(await verdict({ parent: parent([], { user: OTHER }), after: [owner('mehet', 10)] })).toEqual({ kind: 'refused', reason: 'message_sender' })
    expect(await verdict({ parent: parent([], { text: 'más' }), after: [owner('mehet', 10)] })).toEqual({ kind: 'refused', reason: 'message_changed' })
    expect(await verdict({ parent: { ts: '1', user: BOT } })).toEqual({ kind: 'refused', reason: 'message_missing' })
  })

  it('the owner account must be a human (users.info)', async () => {
    expect(await verdict({ after: [owner('mehet', 10)], ownerInfo: { id: OWNER, is_bot: true } })).toEqual({ kind: 'refused', reason: 'owner_not_human' })
  })

  it('the snapshot owner decides: the live setting is not read here at all', async () => {
    const moved = { ...post, ownerUserId: OTHER }
    expect(await verdict({ after: [owner('mehet', 10)] }, moved)).toEqual({ kind: 'none' })
  })
})

describe('the modes', () => {
  it('a post offered only the reply: the owner\'s ✅ reaction does not decide (description content, Dani 66059 rule kept)', async () => {
    const p = parent([], { reactions: [{ name: 'white_check_mark', users: [OWNER], count: 1 }] })
    expect(await verdict({ parent: p })).toEqual({ kind: 'none' })
  })

  it('a post offered only the reaction: a typed "mehet" does not decide, and the replies are not even read', async () => {
    const w: World = { after: [owner('mehet', 10)], calls: [] }
    expect(await checkPost(fake(w), { ...post, reactionMode: true, replyMode: false }, NOW)).toEqual({ kind: 'none' })
    expect(w.calls).toEqual(['conversations.history'])
  })
})

describe('a post offered BOTH: the reaction and the reply are read together (Dani 67810)', () => {
  const both = { ...post, reactionMode: true, replyMode: true }
  const withReaction = (name: string) => parent([], { reactions: [{ name, users: [OWNER], count: 1 }] })
  it('✅ on the request, then the owner types "nem": a refusal (conflict), never an approval', async () => {
    expect(await verdict({ parent: withReaction('white_check_mark'), after: [owner('nem', 10)] }, both)).toEqual({ kind: 'refused', reason: 'reaction_reply_conflict' })
  })
  it('and the other way round: ❌ with a typed "mehet" is a conflict too', async () => {
    expect(await verdict({ parent: withReaction('x'), after: [owner('mehet', 10)] }, both)).toEqual({ kind: 'refused', reason: 'reaction_reply_conflict' })
  })
  it('they agree: the reply decides (it names the owner message)', async () => {
    expect(await verdict({ parent: withReaction('white_check_mark'), after: [owner('mehet', 10)] }, both)).toEqual({ kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts: at(10) } })
  })
  it('only the reaction: it decides', async () => {
    expect(await verdict({ parent: withReaction('white_check_mark') }, both)).toEqual({ kind: 'approved', userId: OWNER })
  })
  it('a typed word still settling holds the reaction back (no decision yet)', async () => {
    const ts = 1700000000 + 10
    expect(await verdict({ parent: withReaction('white_check_mark'), after: [owner('nem', 10)] }, both, ts + 5)).toEqual({ kind: 'none', pending: true })
  })
  it('an edited reply holds the reaction back too: a notice, no decision', async () => {
    expect(await verdict({ parent: withReaction('white_check_mark'), after: [owner('nem', 10, { edited: { ts: at(11) } })] }, both)).toEqual({ kind: 'notice', reason: 'owner_edited' })
  })
})

describe('APPROVAL_SLACK_REPLIES', () => {
  it('off by default; turning it on loosens (the owner\'s own step, Samu 67693), turning it off does not', () => {
    const d = SETTINGS_REGISTRY.find((x) => x.key === 'APPROVAL_SLACK_REPLIES')!
    expect(d.default).toBe('off')
    expect(d.loosens!('off', 'on')).toBe(true)
    expect(d.loosens!('on', 'off')).toBe(false)
    expect(d.validate!('on')).toBeNull()
    expect(d.validate!('igen')).not.toBeNull()
  })
})

// cde47ede: a read that keeps giving 'none' says why, ONCE per post per reason (the sweeper asks every 15 s), and the
// decision is exactly what it was without the log. Each test uses its own approvalId (the seen-set is per process).
describe('a silent no-decision is logged once per post per reason', () => {
  beforeEach(() => warn.mockClear())
  let n = 0
  const fresh = (extra: Partial<ApprovalSlackPost> = {}): ApprovalSlackPost => ({ ...post, approvalId: `diag-${++n}`, ...extra })
  /** The fake above, with single methods answered differently. */
  const over = (w: World, o: { replies?: Msg; history?: Msg; postHistory?: Msg }): SlackCall => {
    const base = fake(w)
    return async (method, body) => {
      if (method === 'conversations.replies' && o.replies) return o.replies
      if (method === 'conversations.history' && body.latest === POST_TS && o.postHistory) return o.postHistory
      if (method === 'conversations.history' && body.latest !== POST_TS && o.history) return o.history
      return base(method, body)
    }
  }
  /** Three sweeper rounds: every verdict, and the reasons warned. */
  async function rounds(call: SlackCall, p: ApprovalSlackPost) {
    const verdicts: unknown[] = []
    for (let i = 0; i < 3; i++) verdicts.push(await checkPost(call, p, NOW))
    return { verdicts, reasons: warn.mock.calls.map((c) => (c[0] as { reason: string }).reason) }
  }
  const clean = () => {
    const text = JSON.stringify(warn.mock.calls)
    expect(text).not.toContain(OWNER)
    expect(text).not.toContain('mehet')
  }

  it('conversations.replies ok:false: its error is logged once; the read still falls back to the run after the request', async () => {
    const p = fresh()
    const r = await rounds(over({ thread: [owner('mehet', 5)], after: [owner('mehet', 10)], calls: [] }, { replies: { ok: false, error: 'invalid_arguments' } }), p)
    expect(r.verdicts).toEqual(Array(3).fill({ kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts: at(10) } }))
    expect(r.reasons).toEqual(['replies_not_ok:invalid_arguments'])
    expect(warn.mock.calls[0][0]).toEqual({ approvalId: p.approvalId, reason: 'replies_not_ok:invalid_arguments', error: 'invalid_arguments' })
    clean()
  })

  it('conversations.replies has_more: logged once, the thread is not used', async () => {
    const r = await rounds(over({ thread: [owner('mehet', 10)], calls: [] }, { replies: { ok: true, has_more: true, messages: [] } }), fresh())
    expect(r.verdicts).toEqual(Array(3).fill({ kind: 'none' }))
    expect(r.reasons).toEqual(['replies_has_more'])
  })

  it('a parent that shows a thread but no reply_count: logged once, the thread is still not read', async () => {
    const w: World = { parent: { ts: POST_TS, user: BOT, text: slackEscape(TEXT), thread_ts: POST_TS, latest_reply: at(10) }, calls: [] }
    const r = await rounds(fake(w), fresh())
    expect(r.verdicts).toEqual(Array(3).fill({ kind: 'none' }))
    expect(w.calls).not.toContain('conversations.replies')
    expect(r.reasons).toEqual(['parent_thread_without_reply_count'])
  })

  it('an owner message dropped for its subtype: the subtype is logged once, in the thread and after the request', async () => {
    const p = fresh()
    const r = await rounds(fake({ thread: [owner('mehet', 10, { subtype: 'thread_broadcast' })], after: [owner('mehet', 10, { subtype: 'thread_broadcast' })], calls: [] }), p)
    expect(r.verdicts).toEqual(Array(3).fill({ kind: 'none' }))
    expect(r.reasons).toEqual(['owner_subtype_dropped:thread:thread_broadcast', 'owner_subtype_dropped:next_message:thread_broadcast'])
    expect(warn.mock.calls[0][0]).toMatchObject({ approvalId: p.approvalId, where: 'thread', subtype: 'thread_broadcast' })
    clean()
  })

  it('the run after the request: history ok:false and has_more are logged once each', async () => {
    const a = await rounds(over({ after: [owner('mehet', 10)], calls: [] }, { history: { ok: false, error: 'missing_scope' } }), fresh())
    expect(a.verdicts).toEqual(Array(3).fill({ kind: 'none' }))
    expect(a.reasons).toEqual(['history_not_ok:missing_scope'])
    warn.mockClear()
    const b = await rounds(fake({ after: [owner('mehet', 10)], hasMore: true, calls: [] }), fresh())
    expect(b.verdicts).toEqual(Array(3).fill({ kind: 'none' }))
    expect(b.reasons).toEqual(['history_has_more'])
  })

  it('reading the request message itself fails: logged once, no decision', async () => {
    const r = await rounds(over({ after: [owner('mehet', 10)], calls: [] }, { postHistory: { ok: false, error: 'channel_not_found' } }), fresh())
    expect(r.verdicts).toEqual(Array(3).fill({ kind: 'none' }))
    expect(r.reasons).toEqual(['post_history_not_ok:channel_not_found'])
  })

  it('a check that throws: sweepOnce logs the error once and still marks the post checked, deciding nothing', async () => {
    const p = fresh()
    const marked: string[] = []
    const decided: unknown[] = []
    const call: SlackCall = async () => { throw new Error('fetch failed') }
    for (let i = 0; i < 3; i++) expect(await sweepOnce(call, [p], (_p, v) => decided.push(v), (x) => marked.push(x.approvalId))).toEqual({ checked: 0, waitS: 0 })
    expect(marked).toEqual([p.approvalId, p.approvalId, p.approvalId])
    expect(decided).toEqual([])
    expect(warn.mock.calls.map((c) => c[0])).toEqual([{ approvalId: p.approvalId, reason: 'check_threw:fetch failed', error: 'fetch failed' }])
  })

  it('a clean decision logs nothing', async () => {
    const r = await rounds(fake({ thread: [owner('mehet', 10)], calls: [] }), fresh())
    expect(r.verdicts[0]).toMatchObject({ kind: 'approved' })
    expect(r.reasons).toEqual([])
  })
})
