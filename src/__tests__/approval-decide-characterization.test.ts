// AGENTCREATEPR1-1119: characterization of today's two decision paths, Slack (APPROVALSLACK1030) and the Teams card
// (TEAMSAPPROVECARD1118), at the row level. Written on develop BEFORE the channel-independent core was extracted, and
// kept unchanged after it: every branch pins the whole approvals row (status, resolved_at, resolved_by, the consumed
// columns) and the channel's own decision row, so the extraction cannot move a single column. The DB is in memory;
// Slack is a fake that only answers chat.postMessage.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createApproval, getApproval, resolveApproval, recordApprovalSlackPost, getApprovalSlackPost,
  decideApprovalFromSlack, recordApprovalTeamsCard, getApprovalTeamsCard, decideApprovalFromTeams, getDb, type Approval,
} from '../db.js'
import { decide } from '../web/approval-slack-route.js'
import type { SlackCall, ApprovalSlackPost } from '../approval-slack.js'

const OWNER = 'U0OWNER01'
const BOT = 'U0BOTUSR1'
const AAD = '6f1c2d3e-0000-4000-8000-000000000001'
const HASH = 'a'.repeat(64)
const now = () => Math.floor(Date.now() / 1000)

let n = 0
function request(over: Partial<{ timeout_at: number | null; content_hash: string | null }> = {}): Approval {
  return createApproval({
    id: `char-${n++}`, agent_id: 'samu', category: 'email_send', action_description: 'leírás',
    timeout_at: over.timeout_at === undefined ? now() + 3600 : over.timeout_at,
    content_hash: over.content_hash === undefined ? HASH : over.content_hash,
  })
}

/** The approvals columns a decision may touch, plus the ones it must never touch. */
function approvalState(id: string) {
  const r = getApproval(id)!
  return {
    status: r.status, resolvedBy: r.resolved_by, resolvedAtSet: r.resolved_at != null,
    consumedAt: r.consumed_at, consumedBy: r.consumed_by ?? null, consumedRef: r.consumed_ref ?? null,
    contentHash: r.content_hash, telegramMessageId: r.telegram_message_id,
  }
}
const untouched = (status: string, contentHash: string | null = HASH) => ({
  status, resolvedBy: null, resolvedAtSet: false, consumedAt: null, consumedBy: null, consumedRef: null, contentHash, telegramMessageId: null,
})
const resolved = (status: string, resolvedBy: string, contentHash: string | null = HASH) => ({
  status, resolvedBy, resolvedAtSet: true, consumedAt: null, consumedBy: null, consumedRef: null, contentHash, telegramMessageId: null,
})

beforeEach(() => { initDatabase(':memory:') })

// ---------------------------------------------------------------- Slack

const POST_TS = '1700000000.000100'
function slackPost(a: Approval, opts: { ts?: string; replyMode?: boolean } = {}): ApprovalSlackPost {
  const ts = opts.ts ?? POST_TS
  const replyMode = opts.replyMode ?? false
  recordApprovalSlackPost({ approvalId: a.id, channel: 'D0DMCHAN1', ts, textSha256: 'f'.repeat(64), ownerUserId: OWNER, botUserId: BOT, contentBasis: 'envelope', reactionMode: !replyMode, replyMode })
  return { approvalId: a.id, channel: 'D0DMCHAN1', ts, textSha256: 'f'.repeat(64), ownerUserId: OWNER, botUserId: BOT, reactionMode: !replyMode, replyMode }
}
function slackWorld(thread: string[]): SlackCall {
  return async (method, body) => {
    if (method === 'chat.postMessage') { thread.push(String(body.text)); return { ok: true, ts: '1700000999.000100' } }
    return { ok: false }
  }
}
function postState(id: string) {
  const p = getApprovalSlackPost(id)!
  return { decidedAtSet: p.decided_at != null, decision: p.decision, decidedByTs: p.decided_by_ts, binding: p.binding }
}
const REPLY_TS = '1700000500.000300'

describe('Slack: every branch of today\'s decision, row by row', () => {
  it('reaction approve by the owner: approved, slack_reaction:<owner>, the post closes with "approved"', async () => {
    const a = request(); const p = slackPost(a)
    await decide(slackWorld([]), p, { kind: 'approved', userId: OWNER }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('approved', `slack_reaction:${OWNER}`))
    expect(postState(a.id)).toEqual({ decidedAtSet: true, decision: 'approved', decidedByTs: null, binding: null })
  })

  it('reaction reject: rejected, slack_reaction:<owner>', async () => {
    const a = request(); const p = slackPost(a)
    await decide(slackWorld([]), p, { kind: 'rejected', userId: OWNER }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('rejected', `slack_reaction:${OWNER}`))
    expect(postState(a.id)).toEqual({ decidedAtSet: true, decision: 'rejected', decidedByTs: null, binding: null })
  })

  it('typed reply approve: slack_reply:<owner>:<ts>, the post records the message and its binding', async () => {
    const a = request(); const p = slackPost(a, { replyMode: true })
    await decide(slackWorld([]), p, { kind: 'approved', userId: OWNER, via: { binding: 'thread', ts: REPLY_TS } }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('approved', `slack_reply:${OWNER}:${REPLY_TS}`))
    expect(postState(a.id)).toEqual({ decidedAtSet: true, decision: 'approved:reply', decidedByTs: REPLY_TS, binding: 'thread' })
  })

  it('typed reply reject: slack_reply:<owner>:<ts>', async () => {
    const a = request(); const p = slackPost(a, { replyMode: true })
    await decide(slackWorld([]), p, { kind: 'rejected', userId: OWNER, via: { binding: 'next_message', ts: REPLY_TS } }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('rejected', `slack_reply:${OWNER}:${REPLY_TS}`))
    expect(postState(a.id)).toEqual({ decidedAtSet: true, decision: 'rejected:reply', decidedByTs: REPLY_TS, binding: 'next_message' })
  })

  it('a refused check (not the owner, an edited message, ...) on a reaction post: a rejection named slack_reaction_refused:<reason>, with an alert', async () => {
    for (const reason of ['not_owner', 'message_edited', 'bot_user']) {
      const a = request(); const p = slackPost(a); const alerts: string[] = []
      await decide(slackWorld([]), p, { kind: 'refused', reason }, (t) => alerts.push(t))
      expect(approvalState(a.id)).toEqual(resolved('rejected', `slack_reaction_refused:${reason}`))
      expect(postState(a.id)).toEqual({ decidedAtSet: true, decision: `refused:${reason}`, decidedByTs: null, binding: null })
      expect(alerts).toHaveLength(1)
    }
  })

  it('a refused check on a reply post: slack_refused:<reason>', async () => {
    const a = request(); const p = slackPost(a, { replyMode: true })
    await decide(slackWorld([]), p, { kind: 'refused', reason: 'message_edited' }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('rejected', 'slack_refused:message_edited'))
  })

  it('an edited owner reply (notice): nothing decided, the post stays open', async () => {
    const a = request(); const p = slackPost(a, { replyMode: true })
    await decide(slackWorld([]), p, { kind: 'notice', reason: 'owner_edited' }, () => {})
    expect(approvalState(a.id)).toEqual(untouched('pending'))
    expect(postState(a.id)).toEqual({ decidedAtSet: false, decision: null, decidedByTs: null, binding: null })
  })

  it('expired, approved: the request stays pending, the post closes with the approval label', async () => {
    const a = request({ timeout_at: now() - 5 }); const p = slackPost(a)
    const thread: string[] = []
    await decide(slackWorld(thread), p, { kind: 'approved', userId: OWNER }, () => {})
    expect(approvalState(a.id)).toEqual(untouched('pending'))
    expect(postState(a.id)).toEqual({ decidedAtSet: true, decision: 'approved', decidedByTs: null, binding: null })
    expect(thread).toHaveLength(1)
  })

  it('expired, rejected: a rejection still lands after the timeout', async () => {
    const a = request({ timeout_at: now() - 5 }); const p = slackPost(a)
    await decide(slackWorld([]), p, { kind: 'rejected', userId: OWNER }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('rejected', `slack_reaction:${OWNER}`))
  })

  it('no timeout at all: an approval lands', async () => {
    const a = request({ timeout_at: null }); const p = slackPost(a)
    await decide(slackWorld([]), p, { kind: 'approved', userId: OWNER }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('approved', `slack_reaction:${OWNER}`))
  })

  it('decided elsewhere first (dashboard rejection): the request keeps the dashboard decision, the post closes', async () => {
    const a = request(); const p = slackPost(a)
    resolveApproval(a.id, 'rejected', 'owner:dashboard')
    await decide(slackWorld([]), p, { kind: 'approved', userId: OWNER }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('rejected', 'owner:dashboard'))
    expect(postState(a.id).decision).toBe('approved')
  })

  it('a timed-out request (status timeout) is not approved', async () => {
    const a = request(); const p = slackPost(a)
    resolveApproval(a.id, 'timeout', 'system')
    await decide(slackWorld([]), p, { kind: 'approved', userId: OWNER }, () => {})
    expect(approvalState(a.id)).toEqual(resolved('timeout', 'system'))
  })

  it('twice: the second decision is logged only, nothing changes, the thread is not answered again', async () => {
    const a = request(); const p = slackPost(a); const thread: string[] = []
    await decide(slackWorld(thread), p, { kind: 'approved', userId: OWNER }, () => {})
    const first = getApproval(a.id)!
    await decide(slackWorld(thread), p, { kind: 'rejected', userId: OWNER }, () => {})
    expect(getApproval(a.id)).toEqual(first)
    expect(postState(a.id).decision).toBe('approved')
    expect(thread).toHaveLength(1)
  })

  it('one owner message, a second request: that request is rejected as slack_refused:reply_already_used', async () => {
    const a = request(); const b = request()
    const pa = slackPost(a, { replyMode: true, ts: '1700000000.000100' }); const pb = slackPost(b, { replyMode: true, ts: '1700000000.000200' })
    const alerts: string[] = []
    await decide(slackWorld([]), pa, { kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts: REPLY_TS } }, () => {})
    await decide(slackWorld([]), pb, { kind: 'approved', userId: OWNER, via: { binding: 'next_message', ts: REPLY_TS } }, (t) => alerts.push(t))
    expect(approvalState(a.id)).toEqual(resolved('approved', `slack_reply:${OWNER}:${REPLY_TS}`))
    expect(approvalState(b.id)).toEqual(resolved('rejected', 'slack_refused:reply_already_used'))
    expect(postState(b.id)).toEqual({ decidedAtSet: true, decision: 'refused:reply_already_used', decidedByTs: null, binding: null })
    expect(alerts).toHaveLength(1)
  })

  it('the Slack path does not compare content_hash: the post binds the message text, checked before the decision', () => {
    const a = request({ content_hash: null }); slackPost(a)
    const r = decideApprovalFromSlack({ approvalId: a.id, decision: 'approved', status: 'approved', resolvedBy: `slack_reaction:${OWNER}` })
    expect(r).toEqual({ outcome: 'recorded', changed: true })
    expect(approvalState(a.id)).toEqual(resolved('approved', `slack_reaction:${OWNER}`, null))
  })

  it('decideApprovalFromSlack return values: recorded+changed, recorded+unchanged (expired), already_decided, and no post row', () => {
    const a = request(); slackPost(a)
    expect(decideApprovalFromSlack({ approvalId: a.id, decision: 'approved', status: 'approved', resolvedBy: 'x' })).toEqual({ outcome: 'recorded', changed: true })
    expect(decideApprovalFromSlack({ approvalId: a.id, decision: 'rejected', status: 'rejected', resolvedBy: 'y' })).toEqual({ outcome: 'already_decided', changed: false })
    const b = request({ timeout_at: now() - 1 }); slackPost(b)
    expect(decideApprovalFromSlack({ approvalId: b.id, decision: 'approved', status: 'approved', resolvedBy: 'x' })).toEqual({ outcome: 'recorded', changed: false })
    const c = request()
    expect(decideApprovalFromSlack({ approvalId: c.id, decision: 'approved', status: 'approved', resolvedBy: 'x' })).toEqual({ outcome: 'already_decided', changed: false })
    expect(approvalState(c.id)).toEqual(untouched('pending'))
  })

  it('a reply_already_used conflict rolls the whole transaction back: the second post stays open, its request pending', () => {
    const a = request(); const b = request()
    slackPost(a, { ts: '1700000000.000100', replyMode: true }); slackPost(b, { ts: '1700000000.000200', replyMode: true })
    decideApprovalFromSlack({ approvalId: a.id, decision: 'approved:reply', status: 'approved', resolvedBy: 'r', decidedByTs: REPLY_TS, binding: 'thread' })
    const r = decideApprovalFromSlack({ approvalId: b.id, decision: 'approved:reply', status: 'approved', resolvedBy: 'r', decidedByTs: REPLY_TS, binding: 'thread' })
    expect(r).toEqual({ outcome: 'reply_already_used', changed: false })
    expect(approvalState(b.id)).toEqual(untouched('pending'))
    expect(postState(b.id)).toEqual({ decidedAtSet: false, decision: null, decidedByTs: null, binding: null })
  })
})

// ---------------------------------------------------------------- Teams

function teamsCard(a: Approval, contentHash = HASH): void {
  recordApprovalTeamsCard({ approvalId: a.id, conversationId: 'a:1conv', activityId: 'card-1', ownerAad: AAD, contentHash, nonceSha256: 'b'.repeat(64), cardSha256: 'c'.repeat(64), lang: 'hu' })
}
function cardState(id: string) {
  const c = getApprovalTeamsCard(id)!
  return { decidedAtSet: c.decided_at != null, decision: c.decision, activity: c.decided_activity_id, by: c.decided_by_aad }
}
const click = (id: string, status: 'approved' | 'rejected', activityId = 'click-1') => decideApprovalFromTeams({ approvalId: id, status, activityId, ownerAad: AAD })

describe('Teams card: every branch of today\'s decision, row by row', () => {
  it('approve: decided, approved, teams_card; the card row keeps the click and the owner', () => {
    const a = request(); teamsCard(a)
    const r = click(a.id, 'approved')
    expect(r.outcome).toBe('decided')
    expect(r.approval?.status).toBe('approved')
    expect(approvalState(a.id)).toEqual(resolved('approved', 'teams_card'))
    expect(cardState(a.id)).toEqual({ decidedAtSet: true, decision: 'approved', activity: 'click-1', by: AAD })
  })

  it('reject: decided, rejected, teams_card', () => {
    const a = request(); teamsCard(a)
    expect(click(a.id, 'rejected').outcome).toBe('decided')
    expect(approvalState(a.id)).toEqual(resolved('rejected', 'teams_card'))
    expect(cardState(a.id).decision).toBe('rejected')
  })

  it('expired approve: "expired", the request stays pending, the card closes as approved:expired', () => {
    const a = request({ timeout_at: now() - 5 }); teamsCard(a)
    const r = click(a.id, 'approved')
    expect(r.outcome).toBe('expired')
    expect(r.approval?.status).toBe('pending')
    expect(approvalState(a.id)).toEqual(untouched('pending'))
    expect(cardState(a.id)).toEqual({ decidedAtSet: true, decision: 'approved:expired', activity: 'click-1', by: AAD })
  })

  it('expired reject: still decided (a rejection lands after the timeout)', () => {
    const a = request({ timeout_at: now() - 5 }); teamsCard(a)
    expect(click(a.id, 'rejected').outcome).toBe('decided')
    expect(approvalState(a.id)).toEqual(resolved('rejected', 'teams_card'))
  })

  it('a timeout exactly now counts as expired (timeout_at <= now)', () => {
    const a = request({ timeout_at: now() }); teamsCard(a)
    expect(click(a.id, 'approved').outcome).toBe('expired')
  })

  it('no timeout at all: decided', () => {
    const a = request({ timeout_at: null }); teamsCard(a)
    expect(click(a.id, 'approved').outcome).toBe('decided')
  })

  it('decided on the dashboard first: not_pending, nothing changes on the request, the card closes as <status>:not_pending', () => {
    const a = request(); teamsCard(a)
    resolveApproval(a.id, 'rejected', 'owner:dashboard')
    const r = click(a.id, 'approved')
    expect(r.outcome).toBe('not_pending')
    expect(r.approval?.status).toBe('rejected')
    expect(approvalState(a.id)).toEqual(resolved('rejected', 'owner:dashboard'))
    expect(cardState(a.id).decision).toBe('approved:not_pending')
  })

  it('a timed-out request: not_pending', () => {
    const a = request(); teamsCard(a)
    resolveApproval(a.id, 'timeout', 'system')
    expect(click(a.id, 'rejected').outcome).toBe('not_pending')
    expect(cardState(a.id).decision).toBe('rejected:not_pending')
  })

  it('another content_hash on the request than on the card: content_changed, nothing decided, the card closes', () => {
    const a = request(); teamsCard(a)
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('d'.repeat(64), a.id)
    const r = click(a.id, 'approved')
    expect(r.outcome).toBe('content_changed')
    expect(approvalState(a.id)).toEqual(untouched('pending', 'd'.repeat(64)))
    expect(cardState(a.id).decision).toBe('approved:content_changed')
  })

  it('a NULL content_hash on the request against the card hash: content_changed', () => {
    const a = request(); teamsCard(a)
    getDb().prepare('UPDATE approvals SET content_hash = NULL WHERE id = ?').run(a.id)
    expect(click(a.id, 'rejected').outcome).toBe('content_changed')
    expect(approvalState(a.id)).toEqual(untouched('pending', null))
  })

  it('pending check comes before the content check: a decided request with a changed hash is not_pending', () => {
    const a = request(); teamsCard(a)
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('d'.repeat(64), a.id)
    resolveApproval(a.id, 'rejected', 'owner:dashboard')
    expect(click(a.id, 'approved').outcome).toBe('not_pending')
  })

  it('content check comes before the timeout check: an expired request with a changed hash is content_changed', () => {
    const a = request({ timeout_at: now() - 5 }); teamsCard(a)
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('d'.repeat(64), a.id)
    expect(click(a.id, 'approved').outcome).toBe('content_changed')
  })

  it('twice: card_already_used, the first decision stands, the card keeps the first click', () => {
    const a = request(); teamsCard(a)
    click(a.id, 'approved', 'click-1')
    const before = getApproval(a.id)
    const r = click(a.id, 'rejected', 'click-2')
    expect(r.outcome).toBe('card_already_used')
    expect(r.approval).toEqual(before)
    expect(cardState(a.id)).toEqual({ decidedAtSet: true, decision: 'approved', activity: 'click-1', by: AAD })
  })

  it('no card row for the request: card_already_used, the request untouched', () => {
    const a = request()
    const r = click(a.id, 'approved')
    expect(r.outcome).toBe('card_already_used')
    expect(r.approval?.status).toBe('pending')
    expect(approvalState(a.id)).toEqual(untouched('pending'))
  })

  it('no request and no card: card_already_used, approval undefined', () => {
    const r = click('no-such-id', 'approved')
    expect(r).toEqual({ outcome: 'card_already_used', approval: undefined })
  })
})
