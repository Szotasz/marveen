// TEAMSAPPROVECARD1118: the wiring of the Teams approval card in the approvals route, on a Teams install.
//   - POST /api/approvals/teams-card-action takes no dashboard token (auth-gate) and answers 401 to one, through the
//     REAL channel-token verifier (a dashboard token is not a Bot Framework channel token).
//   - A new email_send request with the switch on goes out as the card (notifyOwner), not as the text message; with the
//     switch off, or for a request the server cannot verify, the text says the decision is on the dashboard.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getApprovalTeamsCard } from '../db.js'
import { contentAnchor } from '../approval-envelope.js'
import { requiresAuth } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

const ownerTexts: string[] = []
vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async () => ({ attempted: false, sent: false }),
  sendOwnerMessage: async (text: string) => { ownerTexts.push(text); return { sent: true } },
  notifyChannel: async () => {},
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'marveen', TELEGRAM_BOT_TOKEN: '', CHANNEL_PROVIDER: 'teams', CHANNEL_TOKEN: 'app-1', CHANNEL_CHAT_ID: '' }
})

const { tryHandleApprovals, teamsCardDeps } = await import('../web/routes/approvals.js')

const OWNER = '6f1c2d3e-0000-4000-8000-000000000001'
const ENV = { to: ['vevo@example.com'], cc: [], text: 'Tárgy: x\n\nSzia' }
const settings: Record<string, string> = {}
const cards: Array<{ target: string; card?: unknown }> = []
teamsCardDeps.setting = (k) => settings[k] ?? ''
teamsCardDeps.creds = () => ({ appId: 'app-1', secret: 'sec-1', tenant: '11111111-2222-3333-4444-555555555555' })
teamsCardDeps.resolveTarget = (_d, t) => (t === OWNER ? { conversationId: 'a:1owner' } : { reason: 'none' })
teamsCardDeps.send = (async (_c: unknown, _d: string, target: string, _text: string, opts?: { card?: unknown }) => {
  cards.push({ target, card: opts?.card })
  return { status: 201, messageId: 'card-1' }
}) as never

function fakePost(path: string, body: unknown, headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, setHeader() {}, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    headers: { 'content-type': 'application/json', ...headers },
    on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data') cb(Buffer.from(bodyStr)); if (event === 'end') cb(); return req },
  }
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}
async function file(extra: Record<string, unknown> = {}) {
  const { ctx, out } = fakePost('/api/approvals', {
    agent_id: 'marveen', category: 'email_send', action_description: 'leírás', timeout_seconds: 600,
    action_payload: JSON.stringify({ envelope: ENV }), content_hash: contentAnchor(ENV), ...extra,
  })
  await tryHandleApprovals(ctx)
  await new Promise((r) => setTimeout(r, 0))
  return out
}

beforeEach(() => {
  initDatabase(':memory:')
  ownerTexts.length = 0
  cards.length = 0
  for (const k of Object.keys(settings)) delete settings[k]
})

describe('POST /api/approvals/teams-card-action', () => {
  it('takes no dashboard token at the gate (the handler checks a channel token), the other approval routes still do', () => {
    expect(requiresAuth('/api/approvals/teams-card-action', 'POST')).toBe(false)
    expect(requiresAuth('/api/approvals/teams-card-action', 'GET')).toBe(true)
    expect(requiresAuth('/api/approvals', 'POST')).toBe(true)
    expect(requiresAuth('/api/approvals/abc', 'PATCH')).toBe(true)
  })
  it('the shared dashboard token is not a channel token: 401 from the real verifier, before any network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { ctx, out } = fakePost('/api/approvals/teams-card-action', { type: 'invoke', name: 'adaptiveCard/action', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/emea/' },
      // A stand-in of the shared dashboard token's length; built here, not a token-shaped literal (secret-gate).
      { authorization: 'Bearer ' + 'x'.repeat(64) })
    expect(await tryHandleApprovals(ctx)).toBe(true)
    expect(out).toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('notifyOwner on a Teams install', () => {
  it('switch on + explicit owner + a verifiable email_send: the card goes out, the text does not', async () => {
    Object.assign(settings, { APPROVAL_TEAMS_CARDS: 'on', TEAMS_OWNER_AAD_OBJECT_ID: OWNER })
    const out = await file()
    expect(out.status).toBe(201)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.target).toBe('a:1owner')
    expect(JSON.stringify(cards[0]!.card)).toContain('vevo@example.com')
    expect(ownerTexts).toEqual([])
    expect(getApprovalTeamsCard(out.body.id)).toMatchObject({ activity_id: 'card-1', conversation_id: 'a:1owner', owner_aad: OWNER })
  })
  it('switch off: the normal text, no card', async () => {
    Object.assign(settings, { APPROVAL_TEAMS_CARDS: 'off', TEAMS_OWNER_AAD_OBJECT_ID: OWNER })
    await file()
    expect(cards).toEqual([])
    expect(ownerTexts).toHaveLength(1)
    expect(ownerTexts[0]).not.toContain('Teams-kártyás')
  })
  it('switch on but the envelope does not anchor: the text says the decision is on the dashboard', async () => {
    Object.assign(settings, { APPROVAL_TEAMS_CARDS: 'on', TEAMS_OWNER_AAD_OBJECT_ID: OWNER })
    await file({ content_hash: 'f'.repeat(64) })
    expect(cards).toEqual([])
    expect(ownerTexts[0]).toContain('Teams-kártyás jóváhagyás nem érhető el (content_not_verifiable)')
  })
})
