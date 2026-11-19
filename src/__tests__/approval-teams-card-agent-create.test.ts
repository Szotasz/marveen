// AGENTCREATEPR3-1119: the Teams approval card for an agent_create request. The card is rendered from the STORED spec,
// only while its canonical JSON still hashes to the approval's content hash; the agent's own words never reach it. A
// click decides through the same core as an email card, bound to the hash the card showed; the result card speaks of
// the agent. The DB is in memory; Teams is a fake send; the channel-token verifier is a stub.
import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initDatabase, createApproval, getApproval, getDb, type Approval } from '../db.js'
import { teamsCardRoute, renderApprovalCard, postApprovalCard, handleTeamsCardAction, APPROVAL_CARD_VERB, type TeamsCardDeps } from '../web/approval-teams-card.js'
import { canonicalJson, renderAgentSpec, type AgentSpecV1 } from '../web/agent-create-spec.js'
import type { TeamsCreds } from '../teams-send.js'

const OWNER = '6f1c2d3e-0000-4000-8000-000000000001'
const TENANT = '11111111-2222-3333-4444-555555555555'
const CONV = 'a:1ownerPersonalChat'
const CARD_ACTIVITY = 'card-activity-1'
const CREDS: TeamsCreds = { appId: 'app-1', secret: 'sec-1', tenant: TENANT }
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const SPEC: AgentSpecV1 = {
  spec_version: 1, name: 'kutato', display_name: 'Kutató', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default',
  custom_provider: null, channel: { provider: 'telegram', bot_token: { vault_ref: 'TG-KUTATO', value_sha256: sha('x') } },
}

let n = 0
function request(spec: AgentSpecV1 | null = SPEC, hashOver?: string): Approval {
  const id = `ac-${n++}`
  const json = spec ? canonicalJson(spec) : null
  const hash = hashOver ?? (json ? sha(json) : 'a'.repeat(64))
  const a = createApproval({ id, agent_id: 'samu', category: 'agent_create', action_description: 'AZ ÜGYNÖK SAJÁT LEÍRÁSA', action_payload: null, timeout_at: Math.floor(Date.now() / 1000) + 3600, content_hash: hash })
  if (json) getDb().prepare('INSERT INTO agent_create_specs (approval_id, spec_json, content_hash, requested_by, requested_at) VALUES (?, ?, ?, ?, ?)').run(id, json, sha(json), 'samu', Math.floor(Date.now() / 1000))
  return a
}

function makeDeps() {
  const s: Record<string, string> = { APPROVAL_TEAMS_CARDS: 'on', TEAMS_OWNER_AAD_OBJECT_ID: OWNER }
  const sent: Array<{ text: string; card?: Record<string, unknown> }> = []
  const alerts: string[] = []
  const deps: TeamsCardDeps = {
    setting: (k) => s[k] ?? '',
    creds: () => CREDS,
    stateDir: () => '/nowhere',
    resolveTarget: (_dir, target) => (target === OWNER ? { conversationId: CONV } : { reason: 'no personal chat' }),
    send: (async (_c: TeamsCreds, _d: string, _t: string, text: string, opts?: { card?: Record<string, unknown> }) => {
      sent.push({ text, card: opts?.card })
      return { status: 201, messageId: CARD_ACTIVITY }
    }) as unknown as TeamsCardDeps['send'],
    alert: (t) => { alerts.push(t) },
    verifier: () => async () => ({ ok: true, claims: {} }),
  }
  return { deps, sent, alerts }
}
const nonceOf = (card: Record<string, unknown> | undefined) => ((card as any).actions[0].data.nonce as string)
const click = (a: Approval, nonce: string, decision = 'approve') => ({
  type: 'invoke', name: 'adaptiveCard/action', id: 'click-1', replyToId: CARD_ACTIVITY,
  from: { id: '29:x', aadObjectId: OWNER }, conversation: { id: CONV, tenantId: TENANT, conversationType: 'personal' },
  channelData: { tenant: { id: TENANT } },
  value: { action: { type: 'Action.Execute', verb: APPROVAL_CARD_VERB, data: { approvalId: a.id, decision, nonce } } },
})
const cardText = (card: unknown) => JSON.stringify(card)

beforeEach(() => { initDatabase(':memory:') })

describe('teamsCardRoute for agent_create', () => {
  it('a stored spec that still hashes to the approval\'s hash takes the card path, with the spec and no envelope', () => {
    const r = teamsCardRoute(request(), makeDeps().deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.envelope).toBeNull()
    expect(r.spec).toEqual(SPEC)
  })
  it('no stored spec, or a spec whose hash is not the approval\'s: no card (content_not_verifiable)', () => {
    expect(teamsCardRoute(request(null), makeDeps().deps)).toEqual({ ok: false, reason: 'content_not_verifiable' })
    expect(teamsCardRoute(request(SPEC, 'b'.repeat(64)), makeDeps().deps)).toEqual({ ok: false, reason: 'content_not_verifiable' })
  })
})

describe('the agent_create card', () => {
  it('shows the server\'s text of the stored spec, whole, and the hash; never the agent\'s own description', () => {
    const a = request()
    for (const lang of ['hu', 'en'] as const) {
      const card = renderApprovalCard(a, null, a.content_hash!, '2026-11-19 21:00', 'n'.repeat(64), lang, SPEC)
      const text = cardText(card)
      expect(text).toContain(JSON.stringify(renderAgentSpec(SPEC, a.content_hash!, lang)).slice(1, -1))
      expect(text).toContain(a.content_hash!)
      expect(text).not.toContain('AZ ÜGYNÖK SAJÁT LEÍRÁSA')
    }
    expect(cardText(renderApprovalCard(a, null, a.content_hash!, 'x', 'n', 'hu', SPEC))).toContain('Jóváhagyás kell: új ügynök létrehozása')
    expect(cardText(renderApprovalCard(a, null, a.content_hash!, 'x', 'n', 'en', SPEC))).toContain('Approval needed: creating a new agent')
  })
  it('posted with the agent fallback text, bound to the approval\'s hash; the owner\'s click approves it through the core', async () => {
    const a = request()
    const { deps, sent } = makeDeps()
    const route = teamsCardRoute(a, deps)
    if (!route.ok) throw new Error(route.reason)
    expect(await postApprovalCard(a, route, 'x', 'hu', deps)).toBe(true)
    expect(sent[0].text).toContain('új ügynök létrehozása')
    const r = await handleTeamsCardAction('Bearer x', click(a, nonceOf(sent[0].card)), deps)
    expect(getApproval(a.id)!.status).toBe('approved')
    expect(cardText(r.body)).toContain('Az ügynök a jóváhagyott leírás szerint jön létre.')
    expect(cardText(r.body)).not.toContain('levél')
  })
  it('the approval\'s hash changed after the card: the click decides nothing', async () => {
    const a = request()
    const { deps, sent, alerts } = makeDeps()
    const route = teamsCardRoute(a, deps)
    if (!route.ok) throw new Error(route.reason)
    await postApprovalCard(a, route, 'x', 'en', deps)
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('c'.repeat(64), a.id)
    const r = await handleTeamsCardAction('Bearer x', click(a, nonceOf(sent[0].card)), deps)
    expect(getApproval(a.id)!.status).toBe('pending')
    expect(cardText(r.body)).toContain('creating a new agent')
    expect(alerts).toHaveLength(1)
  })
  it('a rejection on the card rejects it (no hash needed for a rejection)', async () => {
    const a = request()
    const { deps, sent } = makeDeps()
    const route = teamsCardRoute(a, deps)
    if (!route.ok) throw new Error(route.reason)
    await postApprovalCard(a, route, 'x', 'hu', deps)
    await handleTeamsCardAction('Bearer x', click(a, nonceOf(sent[0].card), 'reject'), deps)
    expect(getApproval(a.id)!.status).toBe('rejected')
  })
})
