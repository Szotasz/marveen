// APPROVALSLACK1030 B: which requests take the typed-reply path, and how a reply decision is recorded (in one
// transaction, once, one owner message per decision). The DB is in memory; Slack is a fake.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, createApproval, getApproval, getApprovalSlackPost, recordApprovalSlackPost, type Approval } from '../db.js'
import { reactionRoute, decide, sweepRound, postReactionPrompt, startApprovalSlackSweeper, SWEEP_EVERY_MS, OWNER_EDITED_NOTICE, REPLY_EXCLUDED_CATEGORIES, type RouteDeps } from '../web/approval-slack-route.js'
import { contentAnchor } from '../approval-envelope.js'
import { sha256, slackEscape, type SlackCall, type ApprovalSlackPost } from '../approval-slack.js'

const OWNER = 'U0OWNER01'
const BOT = 'U0BOTUSR1'
const ENV = { to: ['a@example.com'], cc: [], text: 'Tárgy: x\n\nSzia' }

function deps(over: Partial<Record<string, string>> = {}): RouteDeps {
  const s: Record<string, string> = { APPROVAL_SLACK_REACTIONS: 'off', APPROVAL_SLACK_REPLIES: 'on', SLACK_OWNER_USER_ID: OWNER, ...over }
  return { setting: (k) => s[k] ?? '', token: () => 'xoxb-test', ownerTarget: async () => 'D0DMCHAN1', verdict: async () => 'ok', drift: async () => false, chunk: 3500 }
}

let n = 0
function request(over: Partial<{ category: string; action_payload: string | null; content_hash: string | null; timeout_at: number }> = {}): Approval {
  return createApproval({
    id: `appr-${n++}`, agent_id: 'samu', category: over.category ?? 'deploy', action_description: 'Éles deploy a connectors-api-ra',
    action_payload: over.action_payload ?? null,
    timeout_at: over.timeout_at ?? Math.floor(Date.now() / 1000) + 3600,
    content_hash: over.content_hash ?? null,
  } as Parameters<typeof createApproval>[0])
}

beforeEach(() => { initDatabase(':memory:') })

describe('reactionRoute with the reply switch', () => {
  it('replies on, reactions off: a description-only request takes the Slack path, offered the reply only', async () => {
    const r = await reactionRoute(request(), false, deps(), 'x', 'u')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.modes).toEqual({ reaction: false, reply: true })
    expect(r.contentBasis).toBe('description')
    expect(r.text).toContain('Éles deploy a connectors-api-ra')
    expect(r.text).toContain('írd be válaszként: mehet (jóváhagyás) vagy nem (elutasítás)')
    expect(r.text).not.toContain('✅')
  })

  it('both switches on: an envelope request is offered both, a description request only the reply', async () => {
    const both = deps({ APPROVAL_SLACK_REACTIONS: 'on' })
    const env = await reactionRoute(request({ category: 'email_send', action_payload: JSON.stringify({ envelope: ENV }), content_hash: contentAnchor(ENV) }), false, both, 'x', 'u')
    expect(env.ok && env.modes).toEqual({ reaction: true, reply: true })
    expect(env.ok && env.text).toContain('vagy reagálj ✅ / ❌')
    const desc = await reactionRoute(request(), false, both, 'x', 'u')
    expect(desc.ok && desc.modes).toEqual({ reaction: false, reply: true })
  })

  it('every excluded category stays on the dashboard, server-filed or not', async () => {
    expect([...REPLY_EXCLUDED_CATEGORIES].sort()).toEqual(['credential_alias', 'data_delete', 'email_standing_recipient', 'update_rebase'])
    for (const category of REPLY_EXCLUDED_CATEGORIES) {
      for (const serverFiled of [false, true]) {
        const r = await reactionRoute(request({ category, content_hash: 'h' }), serverFiled, deps(), 'x', 'u')
        expect(r, `${category} serverFiled=${serverFiled}`).toEqual({ ok: false, reason: 'category_not_for_slack_reply' })
      }
    }
  })

  it('an agent-filed update_rebase never takes Slack, whichever switch is on: category_not_for_slack_reply (AUTOUPDATEDIVERG1110, Dani 74994)', async () => {
    // The agent files it with its own action_description and a content_hash; a typed "mehet" would approve that text,
    // not the server's plan. The owner decides it on the dashboard dialog only.
    for (const reactions of ['off', 'on']) {
      const r = await reactionRoute(request({ category: 'update_rebase', content_hash: 'a'.repeat(64) }), false, deps({ APPROVAL_SLACK_REACTIONS: reactions }), 'x', 'u')
      expect(r, `reactions=${reactions}`).toEqual({ ok: false, reason: 'category_not_for_slack_reply' })
    }
  })

  it('an email_send without a verifiable envelope stays on the dashboard', async () => {
    expect(await reactionRoute(request({ category: 'email_send' }), false, deps(), 'x', 'u')).toEqual({ ok: false, reason: 'content_not_verifiable' })
  })

  it('both switches off: switch_off; reactions only on a description request: still content_not_verifiable (#2452 unchanged)', async () => {
    expect(await reactionRoute(request(), false, deps({ APPROVAL_SLACK_REPLIES: 'off' }), 'x', 'u')).toEqual({ ok: false, reason: 'switch_off' })
    expect(await reactionRoute(request(), false, deps({ APPROVAL_SLACK_REPLIES: 'off', APPROVAL_SLACK_REACTIONS: 'on' }), 'x', 'u'))
      .toEqual({ ok: false, reason: 'content_not_verifiable' })
  })

  it('posting records the modes and the content basis on the row', async () => {
    const a = request()
    const r = await reactionRoute(a, false, deps(), 'x', 'u')
    if (!r.ok) throw new Error(r.reason)
    const call: SlackCall = async (m) => m === 'auth.test' ? { ok: true, user_id: BOT } : { ok: true, ts: '1700000000.000100' }
    expect(await postReactionPrompt(a, r, call)).toBe(true)
    const row = getApprovalSlackPost(a.id)!
    expect([row.reaction_mode, row.reply_mode, row.content_basis]).toEqual([0, 1, 'description'])
  })
})

// A DM world: the request message, and what came after it.
const TEXT = 'kérés'
const POST_TS = '1700000000.000100'
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
function posted(a: Approval, ts = POST_TS, replyMode = true): ApprovalSlackPost {
  recordApprovalSlackPost({ approvalId: a.id, channel: 'D0DMCHAN1', ts, textSha256: sha256(slackEscape(TEXT)), ownerUserId: OWNER, botUserId: BOT, contentBasis: 'description', reactionMode: false, replyMode })
  return { approvalId: a.id, channel: 'D0DMCHAN1', ts, textSha256: sha256(slackEscape(TEXT)), ownerUserId: OWNER, botUserId: BOT, reactionMode: false, replyMode }
}

describe('sweepRound + decide: a typed reply recorded once', () => {
  it('the owner\'s "mehet" right after the request approves it; the record names the owner message; the thread says so', async () => {
    const a = request(); posted(a); const replies: string[] = []
    const ts = old(10)
    await sweepRound(world([{ ts, user: OWNER, text: 'mehet' }], replies), () => {}, { reactions: false, replies: true, pageUrl: 'http://x/#approvals' })
    const row = getApproval(a.id)!
    expect(row.status).toBe('approved')
    expect(row.resolved_by).toBe(`slack_reply:${OWNER}:${ts}`)
    const post = getApprovalSlackPost(a.id)!
    expect([post.decided_by_ts, post.binding, post.decision]).toEqual([ts, 'next_message', 'approved:reply'])
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain(`a ${ts} üzeneted alapján`)
    expect(replies[0]).toContain('Ha nem erre gondoltál: http://x/#approvals')
  })

  it('with the reply switch OFF at sweep time, an already posted reply-only request is not decided', async () => {
    const a = request(); posted(a)
    await sweepRound(world([{ ts: old(10), user: OWNER, text: 'mehet' }], []), () => {}, { reactions: true, replies: false })
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(getApprovalSlackPost(a.id)!.decided_at).toBeNull()
  })

  it('a "mehet" to another question in between does not decide (round level)', async () => {
    const a = request(); posted(a)
    await sweepRound(world([{ ts: old(5), user: BOT, bot_id: 'B0', text: 'Folytathatom?' }, { ts: old(10), user: OWNER, text: 'mehet' }], []), () => {}, { reactions: false, replies: true })
    expect(getApproval(a.id)!.status).toBe('pending')
  })

  it('the transaction re-checks the timeout: an expired request is not approved, the row closes, the thread says why', async () => {
    const a = request({ timeout_at: Math.floor(Date.now() / 1000) - 5 }); const p = posted(a); const replies: string[] = []
    await decide(world([], replies), p, { kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts: old(10) } }, () => {})
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(getApprovalSlackPost(a.id)!.decided_at).not.toBeNull()
    expect(replies[0]).toContain('már nem volt függőben')
  })

  it('one owner message decides one request: the same ts on a second request is a rejection with an alert', async () => {
    const a = request(); const b = request(); const pa = posted(a, '1700000000.000100'); const pb = posted(b, '1700000000.000200')
    const ts = old(10); const alerts: string[] = []
    await decide(world([], []), pa, { kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts } }, () => {})
    await decide(world([], []), pb, { kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts } }, (t) => alerts.push(t))
    expect(getApproval(a.id)!.status).toBe('approved')
    expect(getApproval(b.id)!.status).toBe('rejected')
    expect(getApproval(b.id)!.resolved_by).toBe('slack_refused:reply_already_used')
    expect(alerts).toHaveLength(1)
  })

  it('a decided row stays decided: a later "nem" does not flip it', async () => {
    const a = request(); const p = posted(a); const replies: string[] = []
    await decide(world([], replies), p, { kind: 'approved', userId: OWNER, via: { binding: 'thread', ts: old(10) } }, () => {})
    await decide(world([], replies), p, { kind: 'rejected', userId: OWNER, via: { binding: 'thread', ts: old(20) } }, () => {})
    expect(getApproval(a.id)!.status).toBe('approved')
    expect(replies).toHaveLength(1)
  })

  it('an edited owner reply: one notice in the thread, recorded, never twice; nothing decided', async () => {
    const a = request(); const p = posted(a); const replies: string[] = []
    await decide(world([], replies), p, { kind: 'notice', reason: 'owner_edited' }, () => {})
    await decide(world([], replies), p, { kind: 'notice', reason: 'owner_edited' }, () => {})
    expect(replies).toEqual([OWNER_EDITED_NOTICE])
    expect(getApprovalSlackPost(a.id)!.notice_ts).toBe('1700000999.000100')
    expect(getApproval(a.id)!.status).toBe('pending')
  })

  it('a refused check on a reply post is a rejection named slack_refused, with an alert', async () => {
    const a = request(); const p = posted(a); const alerts: string[] = []
    await decide(world([], []), p, { kind: 'refused', reason: 'message_edited' }, (t) => alerts.push(t))
    expect(getApproval(a.id)!.resolved_by).toBe('slack_refused:message_edited')
    expect(alerts).toHaveLength(1)
  })
})

describe('the wiring: the reply switch alone is enough', () => {
  it('the sweeper runs with only APPROVAL_SLACK_REPLIES on (and stays idle with both off)', async () => {
    vi.useFakeTimers()
    try {
      const a = request(); posted(a)
      for (const [replies, expectCalls] of [['on', true], ['off', false]] as const) {
        const seen: string[] = []
        const call: SlackCall = async (m) => { seen.push(m); return { ok: false } }
        const timer = startApprovalSlackSweeper({ setting: (k) => (k === 'APPROVAL_SLACK_REPLIES' ? replies : 'off'), token: () => 'xoxb-test', alert: () => {}, call: () => call })
        await vi.advanceTimersByTimeAsync(SWEEP_EVERY_MS + 10)
        clearInterval(timer)
        expect(seen.length > 0, `replies=${replies}`).toBe(expectCalls)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('notifyOwner takes the one-message Slack path when either switch is on (source contract, like approvals-delivery)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'routes', 'approvals.ts'), 'utf-8')
    expect(src).toContain('if (!informative && (reactionsOn(reactionDeps.setting) || repliesOn(reactionDeps.setting))) {')
  })
})
