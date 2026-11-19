// AGENTCREATEPR1-1119: the channel-independent decision core (decideApproval, approvalResolvedBy, the category
// consumer). The channel paths' row-level behaviour is pinned in approval-decide-characterization.test.ts; this file
// pins the core's own rules and the consumer hook every adapter shares. The DB is in memory.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createApproval, getApproval, resolveApproval, decideApproval, approvalResolvedBy, registerApprovalConsumer,
  recordApprovalSlackPost, decideApprovalFromSlack, recordApprovalTeamsCard, decideApprovalFromTeams, getDb, type Approval,
} from '../db.js'

const HASH = 'a'.repeat(64)
const now = () => Math.floor(Date.now() / 1000)
const TEAMS = { channel: 'teams', mode: 'card' } as const

let n = 0
function request(over: Partial<{ category: string; timeout_at: number | null; content_hash: string | null }> = {}): Approval {
  return createApproval({
    id: `core-${n++}`, agent_id: 'samu', category: over.category ?? 'email_send', action_description: 'x',
    timeout_at: over.timeout_at === undefined ? now() + 3600 : over.timeout_at,
    content_hash: over.content_hash === undefined ? HASH : over.content_hash,
  })
}

beforeEach(() => { initDatabase(':memory:') })

describe('approvalResolvedBy: <channel>_<mode>, then the trail', () => {
  it('reproduces every audit value the channels wrote before the core', () => {
    expect(approvalResolvedBy({ channel: 'teams', mode: 'card' })).toBe('teams_card')
    expect(approvalResolvedBy({ channel: 'slack', mode: 'reaction', trail: ['U0OWNER01'] })).toBe('slack_reaction:U0OWNER01')
    expect(approvalResolvedBy({ channel: 'slack', mode: 'reply', trail: ['U0OWNER01', '1700000500.000300'] })).toBe('slack_reply:U0OWNER01:1700000500.000300')
    expect(approvalResolvedBy({ channel: 'slack', mode: 'refused', trail: ['message_edited'] })).toBe('slack_refused:message_edited')
    expect(approvalResolvedBy({ channel: 'slack', mode: 'reaction_refused', trail: ['not_owner'] })).toBe('slack_reaction_refused:not_owner')
    expect(approvalResolvedBy({ channel: 'slack', mode: 'reaction', trail: [] })).toBe('slack_reaction')
  })
})

describe('decideApproval: pending, the same hash, before the timeout, once', () => {
  it('approve and reject a pending request; the audit is the evidence', () => {
    const a = request(); const b = request()
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS, expectedContentHash: HASH }).outcome).toBe('decided')
    expect(decideApproval({ approvalId: b.id, status: 'rejected', evidence: { channel: 'slack', mode: 'reaction', trail: ['U1'] } }).outcome).toBe('decided')
    expect([getApproval(a.id)!.status, getApproval(a.id)!.resolved_by]).toEqual(['approved', 'teams_card'])
    expect([getApproval(b.id)!.status, getApproval(b.id)!.resolved_by]).toEqual(['rejected', 'slack_reaction:U1'])
    expect(getApproval(a.id)!.resolved_at).not.toBeNull()
  })

  it('once: a second decision is not_pending and changes nothing', () => {
    const a = request()
    decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS })
    const first = getApproval(a.id)
    expect(decideApproval({ approvalId: a.id, status: 'rejected', evidence: TEAMS }).outcome).toBe('not_pending')
    expect(getApproval(a.id)).toEqual(first)
  })

  it('not pending (decided elsewhere, timed out) or unknown: not_pending', () => {
    const a = request(); resolveApproval(a.id, 'rejected', 'owner:dashboard')
    const b = request(); resolveApproval(b.id, 'timeout', 'system')
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS }).outcome).toBe('not_pending')
    expect(decideApproval({ approvalId: b.id, status: 'rejected', evidence: TEAMS }).outcome).toBe('not_pending')
    expect(decideApproval({ approvalId: 'nope', status: 'approved', evidence: TEAMS })).toEqual({ outcome: 'not_pending', approval: undefined })
  })

  // AGENTCREATEPR2-1119 (Samu, #2903): a null is never a hash the owner was shown, so it matches nothing, a NULL-hash
  // request included (before, NULL to NULL decided).
  const NULL_HASH = null as unknown as string
  it('the expected hash: another hash, or a null one (against a hash or against NULL), is content_changed', () => {
    const a = request()
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS, expectedContentHash: 'b'.repeat(64) }).outcome).toBe('content_changed')
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS, expectedContentHash: NULL_HASH }).outcome).toBe('content_changed')
    expect(getApproval(a.id)!.status).toBe('pending')
    const b = request({ content_hash: null })
    expect(decideApproval({ approvalId: b.id, status: 'approved', evidence: TEAMS, expectedContentHash: HASH }).outcome).toBe('content_changed')
    expect(decideApproval({ approvalId: b.id, status: 'approved', evidence: TEAMS, expectedContentHash: NULL_HASH }).outcome).toBe('content_changed')
    expect(getApproval(b.id)!.status).toBe('pending')
  })

  it('a hash-bound category (agent_create) is approved only with a stored hash that the adapter showed', () => {
    const shown = request({ category: 'agent_create' })
    const unshown = request({ category: 'agent_create' })
    const noHash = request({ category: 'agent_create', content_hash: null })
    const emptyHash = request({ category: 'agent_create', content_hash: '' })
    expect(decideApproval({ approvalId: unshown.id, status: 'approved', evidence: TEAMS }).outcome).toBe('content_changed')
    expect(decideApproval({ approvalId: noHash.id, status: 'approved', evidence: TEAMS }).outcome).toBe('content_changed')
    expect(decideApproval({ approvalId: emptyHash.id, status: 'approved', evidence: TEAMS, expectedContentHash: '' }).outcome).toBe('content_changed')
    expect([unshown, noHash, emptyHash].map((r) => getApproval(r.id)!.status)).toEqual(['pending', 'pending', 'pending'])
    expect(decideApproval({ approvalId: shown.id, status: 'approved', evidence: TEAMS, expectedContentHash: HASH }).outcome).toBe('decided')
  })

  it('a hash-bound category can always be rejected, hash or not', () => {
    const a = request({ category: 'agent_create', content_hash: null })
    expect(decideApproval({ approvalId: a.id, status: 'rejected', evidence: TEAMS }).outcome).toBe('decided')
    expect(getApproval(a.id)!.status).toBe('rejected')
  })

  it('no expected hash: the hash is not compared (the Slack adapter binds the message text instead)', () => {
    const a = request({ content_hash: null })
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS }).outcome).toBe('decided')
  })

  it('an approval at or after the timeout is expired and changes nothing; a rejection still lands', () => {
    const a = request({ timeout_at: now() - 5 }); const b = request({ timeout_at: now() }); const c = request({ timeout_at: now() - 5 })
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS }).outcome).toBe('expired')
    expect(decideApproval({ approvalId: b.id, status: 'approved', evidence: TEAMS }).outcome).toBe('expired')
    expect(getApproval(a.id)!.resolved_by).toBeNull()
    expect(decideApproval({ approvalId: c.id, status: 'rejected', evidence: TEAMS }).outcome).toBe('decided')
  })

  it('the order of the checks: pending, then the hash, then the timeout', () => {
    const a = request({ timeout_at: now() - 5 })
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS, expectedContentHash: 'b'.repeat(64) }).outcome).toBe('content_changed')
    resolveApproval(a.id, 'rejected', 'owner:dashboard')
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS, expectedContentHash: 'b'.repeat(64) }).outcome).toBe('not_pending')
  })

  it('the consumed columns are never touched', () => {
    const a = request()
    decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS })
    const r = getApproval(a.id)!
    expect([r.consumed_at, r.consumed_by, r.consumed_ref]).toEqual([null, null, null])
  })
})

describe('the category consumer: once, after an approval the core decided, on every adapter', () => {
  let cat = 0
  function consumerFor(): { category: string; seen: string[] } {
    const category = `test_consumer_${cat++}`
    const seen: string[] = []
    registerApprovalConsumer(category, (a) => { seen.push(`${a.id}:${a.status}`) })
    return { category, seen }
  }

  it('runs once for an approval through decideApproval, never for a rejection, expiry, changed content or a second call', () => {
    const { category, seen } = consumerFor()
    const ok = request({ category }); const no = request({ category }); const late = request({ category, timeout_at: now() - 5 }); const changed = request({ category })
    decideApproval({ approvalId: ok.id, status: 'approved', evidence: TEAMS })
    decideApproval({ approvalId: ok.id, status: 'approved', evidence: TEAMS })
    decideApproval({ approvalId: no.id, status: 'rejected', evidence: TEAMS })
    decideApproval({ approvalId: late.id, status: 'approved', evidence: TEAMS })
    decideApproval({ approvalId: changed.id, status: 'approved', evidence: TEAMS, expectedContentHash: 'b'.repeat(64) })
    expect(seen).toEqual([`${ok.id}:approved`])
  })

  it('the consumer sees the committed row (approved, resolved_by set)', () => {
    const category = `test_consumer_${cat++}`
    const rows: Array<Approval | undefined> = []
    registerApprovalConsumer(category, (a) => { rows.push(getApproval(a.id)) })
    const a = request({ category })
    decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS })
    expect(rows.map((r) => [r?.status, r?.resolved_by])).toEqual([['approved', 'teams_card']])
  })

  it('runs on the Slack path for an approval that changed the request, not for one that did not', () => {
    const { category, seen } = consumerFor()
    const a = request({ category }); const late = request({ category, timeout_at: now() - 5 })
    for (const [r, ts] of [[a, '1700000000.000100'], [late, '1700000000.000200']] as const) {
      recordApprovalSlackPost({ approvalId: r.id, channel: 'D0', ts, textSha256: 'f'.repeat(64), ownerUserId: 'U0OWNER01', botUserId: 'U0BOT0001' })
    }
    decideApprovalFromSlack({ approvalId: a.id, decision: 'approved', status: 'approved', resolvedBy: 'slack_reaction:U0OWNER01' })
    decideApprovalFromSlack({ approvalId: a.id, decision: 'approved', status: 'approved', resolvedBy: 'slack_reaction:U0OWNER01' })
    decideApprovalFromSlack({ approvalId: late.id, decision: 'approved', status: 'approved', resolvedBy: 'slack_reaction:U0OWNER01' })
    expect(seen).toEqual([`${a.id}:approved`])
  })

  it('runs on the Teams path for a decided approval, not for a rejection or a reused card', () => {
    const { category, seen } = consumerFor()
    const a = request({ category }); const b = request({ category })
    for (const r of [a, b]) recordApprovalTeamsCard({ approvalId: r.id, conversationId: 'c', activityId: 'act', ownerAad: 'o', contentHash: HASH, nonceSha256: 'b'.repeat(64), cardSha256: 'c'.repeat(64), lang: 'hu' })
    decideApprovalFromTeams({ approvalId: a.id, status: 'approved', activityId: 'k1', ownerAad: 'o' })
    decideApprovalFromTeams({ approvalId: a.id, status: 'approved', activityId: 'k2', ownerAad: 'o' })
    decideApprovalFromTeams({ approvalId: b.id, status: 'rejected', activityId: 'k3', ownerAad: 'o' })
    expect(seen).toEqual([`${a.id}:approved`])
  })

  it('another category\'s approval does not run it; no consumer at all is fine', () => {
    const { seen } = consumerFor()
    const a = request({ category: 'email_send' })
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS }).outcome).toBe('decided')
    expect(seen).toEqual([])
  })

  it('a throwing consumer never undoes the decision', () => {
    const category = `test_consumer_${cat++}`
    registerApprovalConsumer(category, () => { throw new Error('boom') })
    const a = request({ category })
    expect(decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS }).outcome).toBe('decided')
    expect(getApproval(a.id)!.status).toBe('approved')
  })

  it('one consumer per category: a second registration throws', () => {
    const { category } = consumerFor()
    expect(() => registerApprovalConsumer(category, () => {})).toThrow(/already registered/)
  })

  it('called inside a caller\'s transaction, the consumer never runs and the caller\'s transaction rolls back', () => {
    const { category, seen } = consumerFor()
    const a = request({ category })
    expect(() => getDb().transaction(() => { decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS }) })())
      .toThrow(/inside a transaction/)
    expect(seen).toEqual([])
    expect(getApproval(a.id)!.status).toBe('pending')
  })

  it('the consumer runs after the commit: a consumer reading through another statement sees the decision', () => {
    const category = `test_consumer_${cat++}`
    let inTx: boolean | undefined
    registerApprovalConsumer(category, () => { inTx = getDb().inTransaction })
    const a = request({ category })
    decideApproval({ approvalId: a.id, status: 'approved', evidence: TEAMS })
    expect(inTx).toBe(false)
  })
})
