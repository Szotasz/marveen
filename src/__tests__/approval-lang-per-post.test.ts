// APPROVALTAGEN1108 (Samu 73344 Q2, 73350; EGM design B1): the language of an approval post is the one it was MADE in,
// stored on its row, never the install key read at sweep time. On a Hungarian post the decide words stay exactly
// mehet/jóváhagyom (approve) and nem/elutasítom (reject); an English post adds approve/go and reject/no; yes/ok never.
// A row from before the column (lang NULL) is Hungarian. The DB is in memory; Slack is a fake.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createApproval, getApproval, getApprovalSlackPost, recordApprovalSlackPost, getDb, type Approval } from '../db.js'
import { reactionRoute, sweepRound, postReactionPrompt, type RouteDeps } from '../web/approval-slack-route.js'
import { sha256, slackEscape, type SlackCall } from '../approval-slack.js'
import { approvalTextLang } from '../web/agent-text-lang.js'

const OWNER = 'U0OWNER01'
const BOT = 'U0BOTUSR1'
const TEXT = 'request'

let n = 0
function request(): Approval {
  return createApproval({
    id: `lang-${n++}`, agent_id: 'samu', category: 'deploy', action_description: 'Deploy to production',
    action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: null,
  } as Parameters<typeof createApproval>[0])
}
const old = (s: number) => `${Math.floor(Date.now() / 1000) - 600 + s}.000300`
function world(after: Array<Record<string, unknown>>, replies: string[]): SlackCall {
  return async (method, body) => {
    if (method === 'conversations.history') {
      if (body.latest !== undefined) return { ok: true, messages: [{ ts: body.latest, user: BOT, text: slackEscape(TEXT), reply_count: 0 }] }
      return { ok: true, messages: [...after].reverse() }
    }
    if (method === 'users.info') return { ok: true, user: { id: OWNER, is_bot: false, is_app_user: false, deleted: false } }
    if (method === 'chat.postMessage') { replies.push(String(body.text)); return { ok: true, ts: '1700000999.000100' } }
    return { ok: false }
  }
}
function post(a: Approval, lang?: 'hu' | 'en'): void {
  recordApprovalSlackPost({ approvalId: a.id, channel: 'D0DMCHAN1', ts: '1700000000.000100', textSha256: sha256(slackEscape(TEXT)), ownerUserId: OWNER, botUserId: BOT, contentBasis: 'description', reactionMode: false, replyMode: true, ...(lang ? { lang } : {}) })
}
async function ownerSays(a: Approval, text: string): Promise<{ status: string; replies: string[] }> {
  const replies: string[] = []
  await sweepRound(world([{ ts: old(10), user: OWNER, text }], replies), () => {}, { reactions: false, replies: true, pageUrl: 'http://x/#approvals' })
  return { status: getApproval(a.id)!.status, replies }
}

beforeEach(() => { initDatabase(':memory:') })

describe('the stored post language decides which words decide', () => {
  it('a post recorded in English stores en; one recorded without a language stores NULL', () => {
    const a = request(); post(a, 'en')
    const b = request(); post(b)
    expect(getApprovalSlackPost(a.id)!.lang).toBe('en')
    expect(getApprovalSlackPost(b.id)!.lang).toBeNull()
  })

  for (const [word, status] of [['go', 'approved'], ['approve', 'approved'], ['no', 'rejected'], ['reject', 'rejected'], ['mehet', 'approved'], ['nem', 'rejected']] as const) {
    it(`an English post: "${word}" decides (${status}), and the thread answers in English`, async () => {
      const a = request(); post(a, 'en')
      const r = await ownerSays(a, word)
      expect(r.status).toBe(status)
      expect(r.replies).toHaveLength(1)
      expect(r.replies[0]).toMatch(status === 'approved' ? /^Approved \(/ : /^Rejected \(/)
    })
  }

  for (const word of ['yes', 'ok', 'approved', 'nope']) {
    it(`an English post: "${word}" never decides`, async () => {
      const a = request(); post(a, 'en')
      expect((await ownerSays(a, word)).status).toBe('pending')
    })
  }

  for (const word of ['go', 'approve', 'no', 'reject', 'yes', 'ok']) {
    it(`a Hungarian post: "${word}" does NOT decide (the Hungarian word list is unchanged)`, async () => {
      const a = request(); post(a, 'hu')
      expect((await ownerSays(a, word)).status).toBe('pending')
    })
  }

  it('a row from before the column (lang NULL) is Hungarian: "go" does not decide, "mehet" does, the thread is Hungarian', async () => {
    const a = request(); post(a)
    expect((await ownerSays(a, 'go')).status).toBe('pending')
    const r = await ownerSays(a, 'mehet')
    expect(r.status).toBe('approved')
    expect(r.replies[0]).toMatch(/^Jóváhagyva \(/)
  })

  it('a NULL row set to en directly in the table decides with "go": the sweep reads the row, not the install key', async () => {
    // The install key in this test process is unset (Hungarian), so only the row can make "go" decide.
    expect(approvalTextLang(() => ({}))).toBe('hu')
    const a = request(); post(a)
    getDb().prepare('UPDATE approval_slack_posts SET lang = ? WHERE approval_id = ?').run('en', a.id)
    expect((await ownerSays(a, 'go')).status).toBe('approved')
  })
})

describe('the route records the language it worded the post in', () => {
  const deps = (): RouteDeps => {
    const s: Record<string, string> = { APPROVAL_SLACK_REACTIONS: 'off', APPROVAL_SLACK_REPLIES: 'on', SLACK_OWNER_USER_ID: OWNER }
    return { setting: (k) => s[k] ?? '', token: () => 'xoxb-test', ownerTarget: async () => 'D0DMCHAN1', verdict: async () => 'ok', drift: async () => false, chunk: 3500 }
  }
  const call: SlackCall = async (m) => m === 'auth.test' ? { ok: true, user_id: BOT } : { ok: true, ts: '1700000000.000100' }

  it('an English route posts English text and stores en; a Hungarian one stores NULL (= hu)', async () => {
    const a = request()
    const en = await reactionRoute(a, false, deps(), 'x', 'u', 'en')
    if (!en.ok) throw new Error(en.reason)
    expect(en.text.startsWith('[APPROVAL NEEDED] samu | deploy\n')).toBe(true)
    expect(await postReactionPrompt(a, en, call)).toBe(true)
    expect(getApprovalSlackPost(a.id)!.lang).toBe('en')
    const b = request()
    const hu = await reactionRoute(b, false, deps(), 'x', 'u', 'hu')
    if (!hu.ok) throw new Error(hu.reason)
    expect(hu.text.startsWith('[JÓVÁHAGYÁS KELL] samu | deploy\n')).toBe(true)
    expect(await postReactionPrompt(b, hu, call)).toBe(true)
    expect(getApprovalSlackPost(b.id)!.lang).toBeNull()
  })

  it('the one-message limit holds for the English text: exactly the chunk fits, one character more falls back', async () => {
    // Same-length ids, so the description is the only difference between the three.
    const mk = (id: string, description: string) => createApproval({ id, agent_id: 'samu', category: 'deploy', action_description: description,
      action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: null } as Parameters<typeof createApproval>[0])
    const probe = await reactionRoute(mk('prb-0001', 'd'), false, deps(), 'x', 'u', 'en')
    if (!probe.ok) throw new Error(probe.reason)
    const overhead = probe.text.length - 1
    const rFits = await reactionRoute(mk('fit-0001', 'd'.repeat(3500 - overhead)), false, deps(), 'x', 'u', 'en')
    expect(rFits.ok && rFits.text.length).toBe(3500)
    const rOver = await reactionRoute(mk('ovr-0001', 'd'.repeat(3501 - overhead)), false, deps(), 'x', 'u', 'en')
    expect(rOver).toEqual({ ok: false, reason: 'too_long_for_one_message' })
  })
})

describe('approvalTextLang: the explicit key only', () => {
  it('en only for AGENT_TEXT_LANG=en; unset, hu or any other value is hu', () => {
    expect(approvalTextLang(() => ({ AGENT_TEXT_LANG: 'en' }))).toBe('en')
    for (const v of [undefined, 'hu', 'EN', 'english', '']) {
      const read = (): Record<string, string> => (v === undefined ? {} : { AGENT_TEXT_LANG: v })
      expect(approvalTextLang(read), String(v)).toBe('hu')
    }
  })
})
