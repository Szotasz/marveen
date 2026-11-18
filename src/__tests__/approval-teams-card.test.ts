// TEAMSAPPROVECARD1118: the Teams approval card. Which requests get a card, what the server renders, how the posted card
// is bound, and how a forwarded click is decided (once, by the owner, on that card, with its nonce, while pending).
// The DB is in memory; Teams is a fake send; the channel-token verifier is a stub here (bot-channel-token.test.ts
// tests the real one).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { initDatabase, createApproval, getApproval, getApprovalTeamsCard, resolveApproval, getDb, type Approval } from '../db.js'
import {
  teamsCardRoute, renderApprovalCard, postApprovalCard, handleTeamsCardAction, APPROVAL_CARD_VERB, CARD_TEXT_PREVIEW,
  type TeamsCardDeps,
} from '../web/approval-teams-card.js'
import { contentAnchor } from '../approval-envelope.js'
import type { TeamsCreds } from '../teams-send.js'

const OWNER = '6f1c2d3e-0000-4000-8000-000000000001'
const STRANGER = '6f1c2d3e-0000-4000-8000-000000000002'
const TENANT = '11111111-2222-3333-4444-555555555555'
const CONV = 'a:1ownerPersonalChat'
const CARD_ACTIVITY = 'card-activity-1'
const CREDS: TeamsCreds = { appId: 'app-1', secret: 'sec-1', tenant: TENANT }
const ENV = { to: ['vevo@example.com'], cc: ['masolat@example.com'], bcc: ['titkos@example.com'], text: 'Tárgy: ajánlat\n\nKedves Vevő, ...' }
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

let n = 0
function request(over: Partial<{ category: string; action_payload: string | null; content_hash: string | null; timeout_at: number | null }> = {}): Approval {
  return createApproval({
    id: `appr-${n++}`, agent_id: 'marveen', category: over.category ?? 'email_send', action_description: 'AZ ÜGYNÖK SAJÁT LEÍRÁSA',
    action_payload: over.action_payload === undefined ? JSON.stringify({ envelope: ENV }) : over.action_payload,
    timeout_at: over.timeout_at === undefined ? Math.floor(Date.now() / 1000) + 3600 : over.timeout_at,
    content_hash: over.content_hash === undefined ? contentAnchor(ENV) : over.content_hash,
  })
}

function makeDeps(settings: Record<string, string> = {}, over: Partial<TeamsCardDeps> = {}) {
  const s: Record<string, string> = { APPROVAL_TEAMS_CARDS: 'on', TEAMS_OWNER_AAD_OBJECT_ID: OWNER, ...settings }
  const sent: Array<{ target: string; text: string; card?: Record<string, unknown> }> = []
  const alerts: string[] = []
  const tokenCalls: Array<{ header: string | undefined; activity: unknown }> = []
  const deps: TeamsCardDeps = {
    setting: (k) => s[k] ?? '',
    creds: () => CREDS,
    stateDir: () => '/nowhere',
    resolveTarget: (_dir, target) => (target === OWNER ? { conversationId: CONV } : { reason: 'no personal chat' }),
    send: (async (_c: TeamsCreds, _d: string, target: string, text: string, opts?: { card?: Record<string, unknown> }) => {
      sent.push({ target, text, card: opts?.card })
      return { status: 201, messageId: CARD_ACTIVITY }
    }) as unknown as TeamsCardDeps['send'],
    alert: (t) => { alerts.push(t) },
    verifier: () => async (header, activity) => { tokenCalls.push({ header, activity }); return { ok: true, claims: {} } },
    ...over,
  }
  return { deps, sent, alerts, tokenCalls, settings: s }
}

beforeEach(() => { initDatabase(':memory:') })

describe('teamsCardRoute: only a verifiable email_send, to an explicit owner, with the bot credentials', () => {
  it('a verifiable email_send takes the card path', () => {
    const r = teamsCardRoute(request(), makeDeps().deps)
    expect(r.ok && r.owner).toBe(OWNER)
  })
  it('every missing condition keeps the decision on the dashboard, with its reason', () => {
    const cases: Array<[Approval, TeamsCardDeps, string]> = [
      [request(), makeDeps({ APPROVAL_TEAMS_CARDS: 'off' }).deps, 'switch_off'],
      [request(), makeDeps({ TEAMS_OWNER_AAD_OBJECT_ID: '' }).deps, 'no_explicit_owner'],
      [request(), makeDeps({ TEAMS_OWNER_AAD_OBJECT_ID: 'not-a-guid' }).deps, 'no_explicit_owner'],
      [request({ category: 'data_delete', action_payload: null, content_hash: 'a'.repeat(64) }), makeDeps().deps, 'not_email_send'],
      [request({ content_hash: 'f'.repeat(64) }), makeDeps().deps, 'content_not_verifiable'],
      [request({ action_payload: null }), makeDeps().deps, 'content_not_verifiable'],
      [request(), makeDeps({}, { creds: () => null }).deps, 'no_teams_credentials'],
    ]
    for (const [a, d, reason] of cases) expect(teamsCardRoute(a, d)).toEqual({ ok: false, reason })
  })
})

describe('renderApprovalCard: the server renders the stored envelope, never the agent description', () => {
  it('shows recipients, cc, bcc, the text and the anchor; buttons carry the reserved verb, the id and the nonce', () => {
    const a = request()
    const card = renderApprovalCard(a, ENV, contentAnchor(ENV), 'holnap 10:00', 'ab'.repeat(32), 'hu')
    const json = JSON.stringify(card)
    for (const s of ['vevo@example.com', 'masolat@example.com', 'titkos@example.com', 'Kedves Vevő', contentAnchor(ENV), 'holnap 10:00']) expect(json).toContain(s)
    expect(json).not.toContain('AZ ÜGYNÖK SAJÁT LEÍRÁSA')
    const actions = card.actions as Array<{ type: string; verb: string; data: Record<string, string> }>
    expect(actions.map((x) => [x.type, x.verb, x.data.decision])).toEqual([['Action.Execute', APPROVAL_CARD_VERB, 'approve'], ['Action.Execute', APPROVAL_CARD_VERB, 'reject']])
    expect(actions.every((x) => x.data.approvalId === a.id && x.data.nonce === 'ab'.repeat(32))).toBe(true)
    expect(card.version).toBe('1.4')
  })
  it('a long text is cut, and the card says where the rest is', () => {
    const long = { ...ENV, text: 'x'.repeat(CARD_TEXT_PREVIEW + 25) }
    const json = JSON.stringify(renderApprovalCard(request(), long, 'h', 'e', 'n', 'en'))
    expect(json).not.toContain('x'.repeat(CARD_TEXT_PREVIEW + 1))
    expect(json).toContain('(+25 characters: the full text is on the dashboard)')
  })
})

async function postCard(a: Approval, d: TeamsCardDeps, sent: Array<{ card?: Record<string, unknown> }>) {
  const route = teamsCardRoute(a, d)
  if (!route.ok) throw new Error(route.reason)
  expect(await postApprovalCard(a, route, 'holnap', 'hu', d)).toBe(true)
  const card = sent[sent.length - 1]!.card as { actions: Array<{ data: { nonce: string } }> }
  return card.actions[0]!.data.nonce
}

describe('postApprovalCard', () => {
  it('sends the card to the owner 1:1 conversation and records the binding with the nonce hash only', async () => {
    const { deps, sent } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.target).toBe(CONV)
    const row = getApprovalTeamsCard(a.id)!
    expect(row).toMatchObject({ conversation_id: CONV, activity_id: CARD_ACTIVITY, owner_aad: OWNER, content_hash: contentAnchor(ENV), lang: 'hu', decided_at: null })
    expect(row.nonce_sha256).toBe(sha(nonce))
    expect(JSON.stringify(row)).not.toContain(nonce)
  })
  it('no 1:1 chat, a failed send, or no activity id: false, and no row', async () => {
    const a = request()
    const noChat = makeDeps({ TEAMS_OWNER_AAD_OBJECT_ID: STRANGER })
    expect(await postApprovalCard(a, teamsCardRoute(a, noChat.deps) as never, 'x', 'hu', noChat.deps)).toBe(false)
    expect(noChat.sent).toHaveLength(0)
    const throws = makeDeps({}, { send: (async () => { throw new Error('Teams API 403') }) as never })
    expect(await postApprovalCard(a, teamsCardRoute(a, throws.deps) as never, 'x', 'hu', throws.deps)).toBe(false)
    const noId = makeDeps({}, { send: (async () => ({ status: 201 })) as never })
    expect(await postApprovalCard(a, teamsCardRoute(a, noId.deps) as never, 'x', 'hu', noId.deps)).toBe(false)
    expect(getApprovalTeamsCard(a.id)).toBeUndefined()
  })
})

function click(a: Approval, nonce: string, over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    type: 'invoke', name: 'adaptiveCard/action', id: 'click-1', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/emea/',
    replyToId: CARD_ACTIVITY,
    from: { id: '29:x', aadObjectId: OWNER },
    conversation: { id: CONV, tenantId: TENANT, conversationType: 'personal' },
    channelData: { tenant: { id: TENANT } },
    value: { action: { type: 'Action.Execute', verb: APPROVAL_CARD_VERB, data: { approvalId: a.id, decision: 'approve', nonce, ...data } } },
    ...over,
  }
}
const cardText = (r: { body: { card?: unknown } }) => JSON.stringify(r.body.card)

describe('handleTeamsCardAction: a forwarded click', () => {
  it('the owner approves on the posted card: approved once, audited, and the card says so', async () => {
    const { deps, sent, alerts, tokenCalls } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    const act = click(a, nonce)
    const r = await handleTeamsCardAction('Bearer channel.jwt.here', act, deps)
    expect(r.status).toBe(200)
    expect(cardText(r)).toContain('Jóváhagyva')
    expect(tokenCalls).toEqual([{ header: 'Bearer channel.jwt.here', activity: act }])
    expect(getApproval(a.id)).toMatchObject({ status: 'approved', resolved_by: 'teams_card' })
    expect(getApprovalTeamsCard(a.id)).toMatchObject({ decision: 'approved', decided_activity_id: 'click-1', decided_by_aad: OWNER })
    expect(alerts).toEqual([])
    const again = await handleTeamsCardAction('Bearer channel.jwt.here', click(a, nonce, {}, { decision: 'reject' }), deps)
    expect(cardText(again)).toContain('Erről a kérésről már döntöttek')
    expect(getApproval(a.id)?.status).toBe('approved')
  })

  it('the owner rejects', async () => {
    const { deps, sent } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    const r = await handleTeamsCardAction('Bearer t', click(a, nonce, {}, { decision: 'reject' }), deps)
    expect(cardText(r)).toContain('Elutasítva')
    expect(getApproval(a.id)?.status).toBe('rejected')
  })

  it('no channel token: 401, nothing decided, no alert, no card', async () => {
    const { deps, sent, alerts } = makeDeps({}, { verifier: () => async () => ({ ok: false, reason: 'not a Bot Framework channel token (issuer)' }) })
    const a = request()
    const nonce = await postCard(a, deps, sent)
    // A stand-in of the shared dashboard token, built here, not a token-shaped literal (secret-gate).
    const r = await handleTeamsCardAction('Bearer ' + 'x'.repeat(64), click(a, nonce), deps)
    expect(r).toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(getApproval(a.id)?.status).toBe('pending')
    expect(getApprovalTeamsCard(a.id)?.decided_at).toBeNull()
    expect(alerts).toEqual([])
  })

  const refusals: Array<[string, (a: Approval, nonce: string) => unknown, string]> = [
    ['another person', (a, nonce) => click(a, nonce, { from: { id: '29:y', aadObjectId: STRANGER } }), 'not_the_owner'],
    ['no aadObjectId', (a, nonce) => click(a, nonce, { from: { id: '29:y' } }), 'not_the_owner'],
    ['another tenant on the conversation', (a, nonce) => click(a, nonce, { conversation: { id: CONV, tenantId: 'other-tenant' } }), 'tenant'],
    ['another tenant in the channel data', (a, nonce) => click(a, nonce, { channelData: { tenant: { id: 'other-tenant' } } }), 'tenant'],
    ['no tenant in the channel data', (a, nonce) => click(a, nonce, { channelData: {} }), 'tenant'],
    ['a wrong nonce', (a) => click(a, 'cd'.repeat(32)), 'nonce'],
    ['a click on another message', (a, nonce) => click(a, nonce, { replyToId: 'some-other-activity' }), 'not_the_posted_card'],
    ['a click in another conversation', (a, nonce) => click(a, nonce, { conversation: { id: 'a:1other', tenantId: TENANT } }), 'not_the_posted_card'],
  ]
  for (const [name, make, reason] of refusals) {
    it(`refused, nothing decided, the owner alerted: ${name}`, async () => {
      const { deps, sent, alerts } = makeDeps()
      const a = request()
      const nonce = await postCard(a, deps, sent)
      const r = await handleTeamsCardAction('Bearer t', make(a, nonce), deps)
      expect(r.status).toBe(200)
      expect(cardText(r)).toContain('nem fogadható el')
      expect(getApproval(a.id)?.status).toBe('pending')
      expect(getApprovalTeamsCard(a.id)?.decided_at).toBeNull()
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toContain(`(${reason})`)
      // the real owner can still decide on the same card
      expect(cardText(await handleTeamsCardAction('Bearer t', click(a, nonce), deps))).toContain('Jóváhagyva')
    })
  }

  it('the switch turned off after the card went out: refused', async () => {
    const { deps, sent, alerts, settings } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    settings.APPROVAL_TEAMS_CARDS = 'off'
    const r = await handleTeamsCardAction('Bearer t', click(a, nonce), deps)
    expect(cardText(r)).toContain('nem fogadható el')
    expect(alerts[0]).toContain('(switch_off)')
    expect(getApproval(a.id)?.status).toBe('pending')
  })

  it('no card was posted for that request: refused', async () => {
    const { deps, alerts } = makeDeps()
    const a = request()
    const r = await handleTeamsCardAction('Bearer t', click(a, 'ab'.repeat(32)), deps)
    expect(cardText(r)).toContain('nem fogadható el')
    expect(alerts[0]).toContain('(no_card)')
  })

  it('an expired request is not approved: the card says expired', async () => {
    const { deps, sent } = makeDeps()
    const a = request({ timeout_at: Math.floor(Date.now() / 1000) + 3600 })
    const nonce = await postCard(a, deps, sent)
    getDb().prepare('UPDATE approvals SET timeout_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, a.id)
    const r = await handleTeamsCardAction('Bearer t', click(a, nonce), deps)
    expect(cardText(r)).toContain('Lejárt')
    expect(getApproval(a.id)?.status).toBe('pending')
  })

  it('already decided on the dashboard: the card says so, nothing changes', async () => {
    const { deps, sent } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    resolveApproval(a.id, 'rejected', 'owner:dashboard')
    const r = await handleTeamsCardAction('Bearer t', click(a, nonce), deps)
    expect(cardText(r)).toContain('Erről a kérésről már döntöttek')
    expect(getApproval(a.id)).toMatchObject({ status: 'rejected', resolved_by: 'owner:dashboard' })
  })

  it('a timed-out request: the card says expired', async () => {
    const { deps, sent } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    resolveApproval(a.id, 'timeout', 'system')
    expect(cardText(await handleTeamsCardAction('Bearer t', click(a, nonce), deps))).toContain('Lejárt')
  })

  it('the content_hash changed after the card: nothing decided, the owner alerted', async () => {
    const { deps, sent, alerts } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run('e'.repeat(64), a.id)
    const r = await handleTeamsCardAction('Bearer t', click(a, nonce), deps)
    expect(cardText(r)).toContain('megváltozott')
    expect(getApproval(a.id)?.status).toBe('pending')
    expect(alerts).toHaveLength(1)
  })

  it('something that is not an approval-card click: 400', async () => {
    const { deps, sent } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    for (const act of [
      click(a, nonce, { type: 'message' }),
      click(a, nonce, { name: 'task/fetch' }),
      { ...click(a, nonce), value: { action: { type: 'Action.Submit', verb: APPROVAL_CARD_VERB, data: { approvalId: a.id, decision: 'approve', nonce } } } },
      { ...click(a, nonce), value: { action: { type: 'Action.Execute', verb: 'teams-plugin-user-view', data: { approvalId: a.id, decision: 'approve', nonce } } } },
      click(a, nonce, {}, { decision: 'maybe' }),
    ]) expect((await handleTeamsCardAction('Bearer t', act, deps)).status).toBe(400)
    expect(getApproval(a.id)?.status).toBe('pending')
  })

  it('no Teams credentials on the install: 503, the card says decide on the dashboard', async () => {
    const { deps } = makeDeps({}, { creds: () => null })
    const r = await handleTeamsCardAction('Bearer t', click(request(), 'ab'.repeat(32)), deps)
    expect(r.status).toBe(503)
  })
})

describe('the decision is recorded once even if two clicks race', () => {
  it('two concurrent owner clicks: one decides, the other sees already decided', async () => {
    const { deps, sent } = makeDeps()
    const a = request()
    const nonce = await postCard(a, deps, sent)
    const [r1, r2] = await Promise.all([
      handleTeamsCardAction('Bearer t', click(a, nonce), deps),
      handleTeamsCardAction('Bearer t', click(a, nonce, {}, { decision: 'reject' }), deps),
    ])
    const texts = [cardText(r1), cardText(r2)]
    expect(texts.filter((t) => t.includes('már döntöttek'))).toHaveLength(1)
    expect(['approved', 'rejected']).toContain(getApproval(a.id)?.status)
    vi.restoreAllMocks()
  })
})
