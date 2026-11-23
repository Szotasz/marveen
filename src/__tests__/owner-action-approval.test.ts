// OWNERACTION1123: an owner-only action (a channel setup, a pairing approve) an agent asks for and the server runs once
// the owner approved it, end to end at the server, with negative controls: the switch off, a refused request, the
// reserved category, the shared token (a request only, never the action), the owner session without or with another
// hash, a vault value swapped after the filing, a pairing code that names another sender by then, a second consume,
// the open-request cap, and the start-up sweep. The DB is in memory; the channel setup is a recorder (its own
// behaviour is pinned by agent-channel-setup-characterization), the pairing approve is the REAL lifted route code.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  root: '',
  alerts: [] as string[],
  ownerLines: [] as string[],
  asked: [] as string[],
  settings: { OWNER_ACTION_VIA_APPROVAL: 'on' } as Record<string, string>,
  channelSetups: [] as Array<[string, string, Record<string, unknown>]>,
  channelAnswer: { status: 200, body: { ok: true } as Record<string, unknown> },
  acl: {} as Record<string, string[]>,
}))
h.root = mkdtempSync(join(tmpdir(), 'owner-action-'))
afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })

vi.mock('../web/vault.js', async (orig) => ({ ...(await orig<typeof import('../web/vault.js')>()), getSecret: (id: string) => h.vault.get(id) ?? null }))
vi.mock('../web/agent-config.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-config.js')>()), agentDir: (n: string) => join(h.root, n) }))
vi.mock('../web/routes/agents.js', async (orig) => ({
  ...(await orig<typeof import('../web/routes/agents.js')>()),
  setupAgentChannel: async (name: string, provider: string, data: Record<string, unknown>) => { h.channelSetups.push([name, provider, data]); return h.channelAnswer },
}))
vi.mock('../web/vault-acl.js', async (orig) => ({ ...(await orig<typeof import('../web/vault-acl.js')>()), readVaultAcl: () => h.acl }))
vi.mock('../settings-store.js', async (orig) => ({ ...(await orig<typeof import('../settings-store.js')>()), getEffectiveSettingValue: (k: string) => h.settings[k] ?? '' }))
vi.mock('../db.js', async (orig) => {
  const real = await orig<typeof import('../db.js')>()
  return { ...real, createAgentMessage: (_f: string, _t: string, text: string) => { h.alerts.push(text); return 0 as never } }
})

const db = await import('../db.js')
const { tryHandleApprovals, _setOwnerActionNotifierForTest } = await import('../web/routes/approvals.js')
const oa = await import('../web/owner-action.js')
const { pairingChannelDir } = await import('../web/routes/agents.js')
oa.registerOwnerActionConsumer()
oa.outcomeNotice.owner = (t: string) => { h.ownerLines.push(t) }
_setOwnerActionNotifierForTest((a) => { h.asked.push(a.id) })

const BOT = ['xoxb-', '1111-2222-', 'fakefakefakefake'].join('')
const APP = ['xapp-', '1-A0-3333-', 'fakefakefakefake'].join('')
const SETUP = { kind: 'channel_setup', agent: 'prorab', provider: 'slack', botToken: { vault_ref: 'PRORAB-BOT' }, appToken: { vault_ref: 'PRORAB-APP' }, extra: true, allowFrom: ['U0BECI001', 'U0YEVGEN1'] }
const OWNER_SESSION = { kind: 'session', user: 'owner' }

async function call(method: string, path: string, body: unknown, auth: Record<string, unknown> = { kind: 'token', agent: 'marveen' }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = { 'x-agent-id': String((auth as { agent?: string }).agent ?? 'marveen') }
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  await tryHandleApprovals({ req, res, path, method, url, auth } as any)
  return out
}
const file = (body: unknown = SETUP, auth?: Record<string, unknown>) => call('POST', '/api/owner-actions', body, auth)
const approve = (id: string, hash: string | undefined, auth: Record<string, unknown> = OWNER_SESSION) =>
  call('PATCH', `/api/approvals/${id}`, { status: 'approved', resolved_by: 'dashboard', ...(hash !== undefined ? { content_hash: hash } : {}) }, auth)
const row = (id: string) => db.getDb().prepare('SELECT * FROM owner_action_requests WHERE approval_id = ?').get(id) as Record<string, any> | undefined
const settle = () => new Promise((r) => setTimeout(r, 20))
const accessPath = (agent: string, provider: 'telegram' | 'slack') => join(pairingChannelDir(agent, provider), 'access.json')
function writeAccess(agent: string, provider: 'telegram' | 'slack', access: Record<string, unknown>) {
  mkdirSync(pairingChannelDir(agent, provider), { recursive: true })
  writeFileSync(accessPath(agent, provider), JSON.stringify(access, null, 2))
}

beforeEach(() => {
  db.initDatabase(':memory:')
  rmSync(join(h.root, 'prorab'), { recursive: true, force: true })
  mkdirSync(join(h.root, 'prorab'), { recursive: true })
  h.vault = new Map([['PRORAB-BOT', BOT], ['PRORAB-APP', APP]])
  h.alerts.length = 0
  h.ownerLines.length = 0
  h.asked.length = 0
  h.settings = { OWNER_ACTION_VIA_APPROVAL: 'on' }
  h.channelSetups.length = 0
  h.channelAnswer = { status: 200, body: { ok: true } }
  h.acl = { 'PRORAB-BOT': ['marveen'], 'PRORAB-APP': ['marveen'] }
})

describe('POST /api/owner-actions files a request, never the action', () => {
  it('with the switch off: 403, nothing stored', async () => {
    h.settings.OWNER_ACTION_VIA_APPROVAL = 'off'
    const r = await file()
    expect(r.status).toBe(403)
    expect(db.listApprovals({ category: 'owner_action' })).toEqual([])
  })

  it('on, with the shared token: 201, a pending owner_action bound to the hash, the server-rendered text, the owner asked, NO setup', async () => {
    const r = await file()
    expect(r.status).toBe(201)
    expect(Object.keys(r.body).sort()).toEqual(['approvalId', 'contentHash', 'ok'])
    const a = db.getApproval(r.body.approvalId)!
    expect([a.category, a.status, a.content_hash, a.agent_id]).toEqual(['owner_action', 'pending', r.body.contentHash, 'marveen'])
    expect(a.action_description).toContain('Ügynök: prorab')
    expect(a.action_description).toContain('a meglévő csatorna MELLÉ')
    expect(a.action_description).toContain('Bot-token: beállítva (vault: PRORAB-BOT)')
    expect(a.action_description).toContain('U0BECI001, U0YEVGEN1')
    expect(a.action_description).not.toContain(BOT)
    expect(a.action_description).not.toContain(APP)
    expect(row(a.id)!.content_hash).toBe(a.content_hash)
    expect(row(a.id)!.request_json).not.toContain(BOT)
    expect(h.asked).toEqual([a.id])
    await settle()
    expect(h.channelSetups).toEqual([])
  })

  it.each([
    ['an unknown field', { ...SETUP, dmPolicy: 'open' }, 400, 'unknown field: dmPolicy'],
    ['an unknown kind', { ...SETUP, kind: 'agent_delete' }, 400, 'kind must be one of: channel_setup, channel_approve'],
    ['a token as a plain value', { ...SETUP, botToken: BOT }, 400, 'botToken must be { vault_ref }: a secret is never sent as a value'],
    ['a Slack channel without the app token', { ...SETUP, appToken: undefined }, 400, 'a Slack channel needs appToken ({ vault_ref })'],
    ['an agent that does not exist', { ...SETUP, agent: 'nincsilyen' }, 404, 'Agent not found'],
    ['the main agent\'s channel', { ...SETUP, agent: 'marveen' }, 403, 'the main agent\'s channel is set up on the dashboard, not through a request'],
    ['an allowFrom that is not ids', { ...SETUP, allowFrom: ['U1', 'x y'] }, 400, 'allowFrom must be a non-empty array of user ids'],
    ['an unsupported provider', { ...SETUP, provider: 'googlechat' }, 400, 'provider must be one of: telegram, slack, discord'],
  ])('%s: refused, nothing stored', async (_, body, status, error) => {
    expect(await file(body)).toEqual({ status, body: { error } })
    expect(db.listApprovals({ category: 'owner_action' })).toEqual([])
  })

  it('a vault entry the requester may not read: the same answer a missing one gets', async () => {
    h.acl['PRORAB-BOT'] = ['dani']
    expect(await file()).toEqual({ status: 400, body: { error: 'botToken.vault_ref cannot be used: PRORAB-BOT' } })
    expect(await file({ ...SETUP, botToken: { vault_ref: 'NINCS' } })).toEqual({ status: 400, body: { error: 'botToken.vault_ref cannot be used: NINCS' } })
  })

  it('the generic POST /api/approvals cannot file an owner_action row', async () => {
    const r = await call('POST', '/api/approvals', { agent_id: 'marveen', category: 'owner_action', action_description: 'x' })
    expect(r.status).toBe(403)
    expect(db.listApprovals({ category: 'owner_action' })).toEqual([])
  })

  it('at most three open requests per requester: the fourth is 429', async () => {
    for (let i = 0; i < 3; i++) expect((await file()).status).toBe(201)
    expect((await file()).status).toBe(429)
    expect((await file(SETUP, { kind: 'token', agent: 'grafit', tokenAgent: undefined })).status).toBe(400) // grafit is not on the vault list
  })
})

describe('the owner decides on the dashboard, the server runs it once', () => {
  it('the owner session with the shown hash: the setup runs ONCE through setupAgentChannel with the approved values, the outcome is told', async () => {
    const { body } = await file()
    const r = await approve(body.approvalId, body.contentHash)
    expect(r.status).toBe(200)
    expect([r.body.status, r.body.resolved_by]).toEqual(['approved', 'dashboard_owner'])
    await settle()
    expect(h.channelSetups).toEqual([['prorab', 'slack', { botToken: BOT, appToken: APP, extra: true, allowFrom: ['U0BECI001', 'U0YEVGEN1'] }]])
    expect(row(body.approvalId)!.outcome).toBe('done')
    expect(db.getApproval(body.approvalId)!.consumed_at).not.toBeNull()
    expect(h.ownerLines).toHaveLength(1)
    expect(h.ownerLines[0]).toContain('Kész: prorab slack csatornájának beállítása')
    expect(h.ownerLines.join('\n')).not.toContain(BOT)
    // a second consume of the same approval runs nothing
    await oa.consumeOwnerAction(db.getApproval(body.approvalId)!)
    expect(h.channelSetups).toHaveLength(1)
  })

  it('the decision core (what the Slack, Teams and Gromzo adapters call) never approves an owner_action without the shown hash', async () => {
    const { body } = await file()
    const d = db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: { channel: 'teams', mode: 'card' } })
    expect(d.outcome).toBe('content_changed')
    await settle()
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(h.channelSetups).toEqual([])
  })

  it('without the hash: 400; with another hash: 409; nothing decided or run', async () => {
    const { body } = await file()
    expect((await approve(body.approvalId, undefined)).status).toBe(400)
    expect(await approve(body.approvalId, 'e'.repeat(64))).toEqual({ status: 409, body: { error: 'Not approved: content_changed' } })
    await settle()
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(h.channelSetups).toEqual([])
  })

  it.each([
    ['the shared token', { kind: 'token', agent: 'marveen' }],
    ['an agent\'s own token', { kind: 'token', agent: 'marveen', tokenAgent: 'marveen' }],
    ['a full device key without the owner session', { kind: 'device', scope: 'full', device: 'bridge' }],
  ])('%s cannot approve: 403, nothing run', async (_, auth) => {
    const { body } = await file()
    expect((await approve(body.approvalId, body.contentHash, auth)).status).toBe(403)
    await settle()
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(h.channelSetups).toEqual([])
  })

  it('a vault value swapped after the filing: refused, the setup never runs, the owner is told', async () => {
    const { body } = await file()
    h.vault.set('PRORAB-BOT', BOT + 'mas')
    await approve(body.approvalId, body.contentHash)
    await settle()
    expect(h.channelSetups).toEqual([])
    expect(row(body.approvalId)!.outcome).toBe('refused:vault_value_changed')
    expect(h.ownerLines[0]).toContain('megváltozott a jóváhagyás óta')
  })

  it('a setup that fails: the outcome names it, the owner and the main agent are told', async () => {
    h.channelAnswer = { status: 409, body: { error: 'managed-settings-missing' } }
    const { body } = await file()
    await approve(body.approvalId, body.contentHash)
    await settle()
    expect(row(body.approvalId)!.outcome).toBe('failed:409:managed-settings-missing')
    expect(h.ownerLines[0]).toContain('NEM sikerült')
    expect(h.alerts.some((t) => t.includes('NEM sikerült'))).toBe(true)
  })

  it('a stored request changed after the approval: refused at the consume, nothing run', async () => {
    const { body } = await file()
    db.getDb().prepare('UPDATE owner_action_requests SET request_json = replace(request_json, ?, ?) WHERE approval_id = ?').run('U0YEVGEN1', 'U0MASIK01', body.approvalId)
    await approve(body.approvalId, body.contentHash)
    await settle()
    expect(h.channelSetups).toEqual([])
    expect(row(body.approvalId)!.outcome).toBe('refused:stored_request_hash_mismatch')
  })
})

describe('channel_approve: the pairing the owner saw, through the route\'s own code', () => {
  const PAIR = { kind: 'channel_approve', agent: 'prorab', provider: 'telegram', code: 'abc123' }
  const access = () => JSON.parse(readFileSync(accessPath('prorab', 'telegram'), 'utf-8'))

  it('filed with the sender the code names now; approved: that sender is allowed, the code is gone, the marker written', async () => {
    writeAccess('prorab', 'telegram', { dmPolicy: 'pairing', allowFrom: ['111'], pending: { abc123: { senderId: '222', chatId: '222' } } })
    const r = await file(PAIR)
    expect(r.status).toBe(201)
    const a = db.getApproval(r.body.approvalId)!
    expect(a.action_description).toContain('Küldő azonosítója: 222 (chat: 222)')
    expect(access().allowFrom).toEqual(['111'])
    await approve(r.body.approvalId, r.body.contentHash)
    await settle()
    expect(access().allowFrom).toEqual(['111', '222'])
    expect(access().pending).toEqual({})
    expect(existsSync(join(pairingChannelDir('prorab', 'telegram'), 'approved', '222'))).toBe(true)
    expect(row(r.body.approvalId)!.outcome).toBe('done')
  })

  it('a code that names ANOTHER sender by the time it runs: 409, access.json unchanged', async () => {
    writeAccess('prorab', 'telegram', { dmPolicy: 'pairing', allowFrom: [], pending: { abc123: { senderId: '222', chatId: '222' } } })
    const r = await file(PAIR)
    writeAccess('prorab', 'telegram', { dmPolicy: 'pairing', allowFrom: [], pending: { abc123: { senderId: '999', chatId: '999' } } })
    await approve(r.body.approvalId, r.body.contentHash)
    await settle()
    expect(access().allowFrom).toEqual([])
    expect(access().pending.abc123.senderId).toBe('999')
    expect(row(r.body.approvalId)!.outcome).toMatch(/^failed:409:/)
  })

  it('an unknown code is refused at the filing', async () => {
    writeAccess('prorab', 'telegram', { allowFrom: [], pending: {} })
    expect(await file(PAIR)).toEqual({ status: 404, body: { error: 'Invalid or expired code' } })
  })
})

describe('the start-up sweep', () => {
  it('an approved, unconsumed request is run now; one consumed without an outcome is alerted, never re-run', async () => {
    const one = (await file()).body
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'dashboard_owner' WHERE id = ?").run(Math.floor(Date.now() / 1000), one.approvalId)
    const two = (await file()).body
    db.getDb().prepare('UPDATE owner_action_requests SET consumed_at = ? WHERE approval_id = ?').run(Math.floor(Date.now() / 1000), two.approvalId)
    expect(await oa.sweepOwnerActionOnStart()).toEqual({ consumed: 1, interrupted: 1 })
    expect(h.channelSetups).toHaveLength(1)
    expect(row(one.approvalId)!.outcome).toBe('done')
    expect(row(two.approvalId)!.outcome).toBe('interrupted')
    expect(h.alerts.some((t) => t.includes('megszakadt'))).toBe(true)
  })
})
