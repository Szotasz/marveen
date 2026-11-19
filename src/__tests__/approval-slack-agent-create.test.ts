// AGENTCREATEPR3-1119 (Samu 81756, 2): an agent_create request on the Slack reply path. Its post records the content
// hash it showed, and the owner's reply decides against that hash (a request whose hash changed since stays pending); an
// email post records none (unchanged). A request too long for one Slack message is not offered the reply path. The DB is
// in memory; Slack is a fake.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createApproval, getApproval, getApprovalSlackPost, getDb, decideApprovalFromSlack, type Approval } from '../db.js'
import { reactionRoute, postReactionPrompt, type RouteDeps } from '../web/approval-slack-route.js'
import { contentAnchor } from '../approval-envelope.js'
import type { SlackCall } from '../approval-slack.js'

const OWNER = 'U0OWNER01'
const H = 'a'.repeat(64)
const ENV = { to: ['a@example.com'], cc: [], text: 'Tárgy: x\n\nSzia' }

function deps(): RouteDeps {
  const s: Record<string, string> = { APPROVAL_SLACK_REPLIES: 'on', SLACK_OWNER_USER_ID: OWNER }
  return { setting: (k) => s[k] ?? '', token: () => 'xoxb-test', ownerTarget: async () => 'dm', verdict: async () => 'ok', drift: async () => false, chunk: 3500 }
}
const slack: SlackCall = async (method) => {
  if (method === 'auth.test') return { ok: true, user_id: 'U0BOTUSR1' }
  if (method === 'conversations.open') return { ok: true, channel: { id: 'D0DMCHAN1' } }
  if (method === 'chat.postMessage') return { ok: true, ts: '1700000000.000100' }
  return { ok: false }
}
let n = 0
const agentCreate = (text = 'Új ügynök létrehozása, jóváhagyásra:\n- azonosító: kutato'): Approval =>
  createApproval({ id: `ac-${n++}`, agent_id: 'samu', category: 'agent_create', action_description: text, action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: H })
const email = (): Approval =>
  createApproval({ id: `em-${n++}`, agent_id: 'marveen', category: 'email_send', action_description: 'x', action_payload: JSON.stringify({ envelope: ENV }), timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: contentAnchor(ENV) })
async function postFor(a: Approval) {
  const r = await reactionRoute(a, true, deps(), 'x', 'u')
  if (!r.ok) throw new Error(r.reason)
  expect(await postReactionPrompt(a, r, slack)).toBe(true)
}

beforeEach(() => { initDatabase(':memory:') })

describe('an agent_create post binds its content hash', () => {
  it('the post records the request\'s content hash; an email post records none', async () => {
    const a = agentCreate()
    await postFor(a)
    expect(getApprovalSlackPost(a.id)!.content_hash).toBe(H)
    const e = email()
    await postFor(e)
    expect(getApprovalSlackPost(e.id)!.content_hash ?? null).toBeNull()
  })
  it('the owner\'s reply approves it through the core (the hash it showed)', async () => {
    const a = agentCreate()
    await postFor(a)
    expect(decideApprovalFromSlack({ approvalId: a.id, decision: 'approved:reply', status: 'approved', resolvedBy: 'slack_reply:U0OWNER01:1' })).toEqual({ outcome: 'recorded', changed: true })
    expect(getApproval(a.id)!.status).toBe('approved')
  })
  it('the request\'s hash changed after the post: the reply decides nothing, the request stays pending', async () => {
    const a = agentCreate()
    await postFor(a)
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('b'.repeat(64), a.id)
    expect(decideApprovalFromSlack({ approvalId: a.id, decision: 'approved:reply', status: 'approved', resolvedBy: 'slack_reply:U0OWNER01:1' })).toEqual({ outcome: 'recorded', changed: false })
    expect(getApproval(a.id)!.status).toBe('pending')
  })
  it('a rejection is bound the same way, as on the Teams card: the shown hash rejects it, a changed one decides nothing', async () => {
    const a = agentCreate()
    await postFor(a)
    decideApprovalFromSlack({ approvalId: a.id, decision: 'rejected:reply', status: 'rejected', resolvedBy: 'slack_reply:U0OWNER01:1' })
    expect(getApproval(a.id)!.status).toBe('rejected')
    const b = agentCreate()
    await postFor(b)
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('b'.repeat(64), b.id)
    decideApprovalFromSlack({ approvalId: b.id, decision: 'rejected:reply', status: 'rejected', resolvedBy: 'slack_reply:U0OWNER01:2' })
    expect(getApproval(b.id)!.status).toBe('pending')
  })
})

describe('too long for one Slack message', () => {
  it('is not offered the reply path: no post row, so no reply can decide it', async () => {
    const a = agentCreate('x'.repeat(3600))
    expect(await reactionRoute(a, true, deps(), 'x', 'u')).toEqual({ ok: false, reason: 'too_long_for_one_message' })
    expect(getApprovalSlackPost(a.id)).toBeUndefined()
  })
})
