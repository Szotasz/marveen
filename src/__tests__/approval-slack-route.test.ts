// APPROVALSLACK1030 (2): which requests take the Slack-reaction path, and how a decision is recorded (once). The DB is
// in memory; Slack is a fake.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, createApproval, getApproval, getApprovalSlackPost, pendingApprovalSlackPosts, recordApprovalSlackPost, type Approval } from '../db.js'
import { reactionRoute, decide, postReactionPrompt, dashboardOnlyLine, sweepRound, type RouteDeps } from '../web/approval-slack-route.js'
import { sha256 } from '../approval-slack.js'
import { contentAnchor } from '../approval-envelope.js'
import type { SlackCall, ApprovalSlackPost } from '../approval-slack.js'

const OWNER = 'U0OWNER01'
const ENV = { to: ['a@example.com'], cc: [], text: 'Tárgy: x\n\nSzia' }

function deps(over: Partial<Record<string, string>> = {}, extra: Partial<RouteDeps> = {}): RouteDeps {
  const s: Record<string, string> = { APPROVAL_SLACK_REACTIONS: 'on', SLACK_OWNER_USER_ID: OWNER, ...over }
  return { setting: (k) => s[k] ?? '', token: () => 'xoxb-test', ownerTarget: async () => 'dm', verdict: async () => 'ok', drift: async () => false, chunk: 3500, ...extra }
}

let n = 0
function request(over: Partial<{ category: string; action_payload: string | null; content_hash: string | null; action_description: string }> = {}): Approval {
  return createApproval({
    id: `appr-${n++}`, agent_id: 'marveen', category: over.category ?? 'email_send', action_description: over.action_description ?? 'Ártalmatlan leírás',
    action_payload: over.action_payload === undefined ? JSON.stringify({ envelope: ENV }) : over.action_payload,
    timeout_at: Math.floor(Date.now() / 1000) + 3600,
    content_hash: over.content_hash === undefined ? contentAnchor(ENV) : over.content_hash,
  } as Parameters<typeof createApproval>[0])
}

beforeEach(() => { initDatabase(':memory:') })

describe('reactionRoute: only a request the server can stand behind, to an explicit owner', () => {
  it('an email_send whose envelope anchors to its hash: the DM shows the envelope, not the agent\'s description', async () => {
    const r = await reactionRoute(request(), false, deps(), '2026. 11. 02. 10:00', 'http://x/#approvals')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ownerUserId).toBe(OWNER)
    expect(r.text).toContain('Címzett: a@example.com')
    expect(r.text).toContain('Szia')
    expect(r.text).toContain(`Horgony (sha256): ${contentAnchor(ENV)}`)
    expect(r.text).not.toContain('Ártalmatlan leírás')
    expect(r.text).toContain('✅ (jóváhagyás) vagy ❌ (elutasítás)')
  })

  it('a server-filed request shows the server\'s own description', async () => {
    const r = await reactionRoute(request({ category: 'data_delete', action_payload: null, content_hash: 'a'.repeat(64), action_description: 'Memória törlése: 3 sor' }), true, deps(), 'x', 'u')
    expect(r.ok && r.text.includes('Memória törlése: 3 sor')).toBe(true)
  })

  it('every missing condition keeps the decision on the dashboard, with its reason', async () => {
    const cases: Array<[Approval, boolean, RouteDeps, string]> = [
      [request(), false, deps({ APPROVAL_SLACK_REACTIONS: 'off' }), 'switch_off'],
      [request(), false, deps({ SLACK_OWNER_USER_ID: '' }), 'no_explicit_owner'],
      [request(), false, deps({}, { ownerTarget: async () => '' }), 'slack_not_owner_channel'],
      [request(), false, deps({}, { ownerTarget: async () => 'D0C74N9SAF6', verdict: async () => 'foreign' }), 'dm_channel_foreign'],
      [request(), false, deps({}, { token: () => null }), 'no_slack_token'],
      [request({ content_hash: 'f'.repeat(64) }), false, deps(), 'content_not_verifiable'],
      [request({ action_payload: null }), false, deps(), 'content_not_verifiable'],
      [request({ category: 'data_delete', action_payload: null, content_hash: 'a'.repeat(64) }), false, deps(), 'content_not_verifiable'],
      [request(), false, deps({}, { chunk: 50 }), 'too_long_for_one_message'],
    ]
    for (const [a, sf, d, reason] of cases) expect(await reactionRoute(a, sf, d, 'x', 'u')).toEqual({ ok: false, reason })
    expect(dashboardOnlyLine('switch_off')).toContain('a döntés a dashboardon')
  })
})

/** A fake Slack that records thread replies. */
function slack(replies: string[]): SlackCall {
  return async (method, body) => {
    if (method === 'auth.test') return { ok: true, user_id: 'U0BOTUSR1' }
    if (method === 'conversations.open') return { ok: true, channel: { id: 'D0DMCHAN1' } }
    if (method === 'chat.postMessage') {
      if (body.thread_ts) replies.push(String(body.text))
      return { ok: true, ts: '1700000000.000100' }
    }
    return { ok: false }
  }
}

describe('postReactionPrompt + decide: one message, one decision', () => {
  it('posting records the snapshot (owner, channel, ts, text hash, bot) for the sweeper', async () => {
    const a = request()
    const r = await reactionRoute(a, false, deps(), 'x', 'u')
    if (!r.ok) throw new Error(r.reason)
    expect(await postReactionPrompt(a, r, slack([]))).toBe(true)
    const row = getApprovalSlackPost(a.id)!
    expect([row.owner_user_id, row.channel, row.ts, row.bot_user_id, row.decided_at]).toEqual([OWNER, 'D0DMCHAN1', '1700000000.000100', 'U0BOTUSR1', null])
    expect(pendingApprovalSlackPosts().map((p) => p.approval_id)).toEqual([a.id])
  })

  function posted(a: Approval): ApprovalSlackPost {
    recordApprovalSlackPost({ approvalId: a.id, channel: 'D0DMCHAN1', ts: '1700000000.000100', textSha256: 'h', ownerUserId: OWNER, botUserId: 'U0BOTUSR1' })
    return { approvalId: a.id, channel: 'D0DMCHAN1', ts: '1700000000.000100', textSha256: 'h', ownerUserId: OWNER, botUserId: 'U0BOTUSR1' }
  }

  it('the owner\'s ✅ approves the request, records who, and says so in the thread', async () => {
    const a = request(); const p = posted(a); const replies: string[] = []; const alerts: string[] = []
    await decide(slack(replies), p, { kind: 'approved', userId: OWNER }, (t) => alerts.push(t))
    expect(getApproval(a.id)!.status).toBe('approved')
    expect(getApproval(a.id)!.resolved_by).toBe(`slack_reaction:${OWNER}`)
    expect(replies.length === 1 && replies[0].startsWith('Jóváhagyva')).toBe(true)
    expect(alerts).toEqual([])
    expect(pendingApprovalSlackPosts()).toEqual([])
  })

  it('a refused check is a REJECTION with an alert, never an approval', async () => {
    const a = request(); const p = posted(a); const alerts: string[] = []
    await decide(slack([]), p, { kind: 'refused', reason: 'message_edited' }, (t) => alerts.push(t))
    expect(getApproval(a.id)!.status).toBe('rejected')
    expect(getApproval(a.id)!.resolved_by).toBe('slack_reaction_refused:message_edited')
    expect(alerts.length === 1 && alerts[0].includes('message_edited')).toBe(true)
  })

  it('a later reaction change does not reopen or flip anything (Dani 65920 (5))', async () => {
    const a = request(); const p = posted(a); const replies: string[] = []
    await decide(slack(replies), p, { kind: 'approved', userId: OWNER }, () => {})
    await decide(slack(replies), p, { kind: 'rejected', userId: OWNER }, () => {})
    expect(getApproval(a.id)!.status).toBe('approved')
    expect(getApprovalSlackPost(a.id)!.decision).toBe('approved')
    expect(replies).toHaveLength(1)
  })

  it('a request decided elsewhere (dashboard) is not swept again', async () => {
    const a = request(); posted(a)
    const { resolveApproval } = await import('../db.js')
    resolveApproval(a.id, 'rejected', 'owner')
    expect(pendingApprovalSlackPosts()).toEqual([])
  })

  // #2451: the bot has no im:write; a raw owner DM id is posted to directly, after the drift check and the verdict.
  it('a raw D id target: the prompt goes straight there (no conversations.open), after drift and verdict', async () => {
    const seen: string[] = []
    const a = request()
    const d = deps({}, { ownerTarget: async () => 'D0C74N9SAF6', verdict: async (c) => { seen.push(`verdict ${c}`); return 'ok' }, drift: async (t) => { seen.push(`drift ${t}`); return false } })
    const r = await reactionRoute(a, false, d, 'x', 'u')
    if (!r.ok) throw new Error(r.reason)
    expect(r.channel).toBe('D0C74N9SAF6')
    expect(seen).toEqual(['drift D0C74N9SAF6', 'verdict D0C74N9SAF6'])
    const calls: string[] = []
    const call: SlackCall = async (method, body) => {
      calls.push(method)
      if (method === 'auth.test') return { ok: true, user_id: 'U0BOTUSR1' }
      if (method === 'chat.postMessage') return { ok: true, ts: '1700000000.000300', channel: body.channel }
      return { ok: false, error: 'missing_scope' }
    }
    expect(await postReactionPrompt(a, r, call)).toBe(true)
    expect(calls).toEqual(['auth.test', 'chat.postMessage'])
    expect(getApprovalSlackPost(a.id)!.channel).toBe('D0C74N9SAF6')
  })
})

// Dani 66059: oldest-first starved a newer request while 5+ older ones stood unanswered (the normal case: the owner
// ignores what they do not want). The rotation reaches every pending post within ceil(pending / 5) rounds.
describe('sweepRound: rotation, no starvation behind unanswered older requests', () => {
  const TEXT = 'kérés szövege'
  function world(reactedTs: string, seen: string[]): SlackCall {
    return async (method, body) => {
      if (method === 'conversations.history') {
        seen.push(String(body.latest))
        const reactions = body.latest === reactedTs ? [{ name: 'white_check_mark', users: [OWNER], count: 1 }] : []
        return { ok: true, messages: [{ ts: body.latest, user: 'U0BOTUSR1', text: TEXT, reactions }] }
      }
      if (method === 'users.info') return { ok: true, user: { id: OWNER, is_bot: false, is_app_user: false, deleted: false } }
      if (method === 'chat.postMessage') return { ok: true, ts: '1700000999.000100' }
      return { ok: false }
    }
  }

  it('8 pending, only the NEWEST reacted: decided within 2 rounds, every post asked about once', async () => {
    const reqs = Array.from({ length: 8 }, () => request())
    reqs.forEach((a, i) => recordApprovalSlackPost({
      approvalId: a.id, channel: 'D0DMCHAN1', ts: `1700000000.00010${i}`, textSha256: sha256(TEXT), ownerUserId: OWNER, botUserId: 'U0BOTUSR1',
    }))
    const newest = reqs[7]; const seen: string[] = []
    const call = world('1700000000.000107', seen)
    expect((await sweepRound(call, () => {})).checked).toBe(5)
    expect(getApproval(newest.id)!.status).toBe('pending')
    expect((await sweepRound(call, () => {})).checked).toBe(5)
    expect(getApproval(newest.id)!.status).toBe('approved')
    expect(new Set(seen).size).toBe(8)
    expect(pendingApprovalSlackPosts()).toHaveLength(7)
  })

  it('after a full cycle the least recently checked come first again (the rotation keeps going)', async () => {
    const reqs = Array.from({ length: 7 }, () => request())
    reqs.forEach((a, i) => recordApprovalSlackPost({
      approvalId: a.id, channel: 'D0DMCHAN1', ts: `1700000000.00020${i}`, textSha256: sha256(TEXT), ownerUserId: OWNER, botUserId: 'U0BOTUSR1',
    }))
    const seen: string[] = []
    const call = world('none', seen)
    // a strictly increasing clock: in a fast test two stamps could share a millisecond, a tie the real 15 s cadence never has
    let t = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++t)
    try { await sweepRound(call, () => {}); await sweepRound(call, () => {}); await sweepRound(call, () => {}) } finally { clock.mockRestore() }
    // round 1: 0-4; round 2: 5, 6, then the least recently checked of 0-4 (0, 1, 2); round 3: 3, 4, 5, 6, 0
    expect(seen.slice(10, 12)).toEqual(['1700000000.000203', '1700000000.000204'])
  })
})
