// AGENTCREATEPR2-1119: creating an agent through an agent_create approval, end to end at the server, with negative
// controls: the switch off, a refused spec, the shared token (a request only, never an agent), a changed spec, a vault
// value swapped after the approval, a second consume, an expired request, an unshown hash, the status-write guard,
// and the start-up sweep. The DB is in memory; the create itself is a recorder (its own behaviour is pinned by the
// agent-create characterization files), the vault and the CLI probe are stand-ins.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  root: '',
  creates: [] as Array<Record<string, unknown>>,
  createAnswer: { status: 200, body: { ok: true } as Record<string, unknown> },
  alerts: [] as string[],
  settings: { AGENT_CREATE_VIA_APPROVAL: 'on' } as Record<string, string>,
  channelSetups: [] as Array<[string, string, Record<string, unknown>]>,
  channelAnswer: { status: 200, body: { ok: true } as Record<string, unknown> },
  onCreate: null as null | (() => void),
  acl: {} as Record<string, string[]>,
}))
h.root = mkdtempSync(join(tmpdir(), 'agent-create-appr-'))
afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })

vi.mock('../web/vault.js', async (orig) => ({ ...(await orig<typeof import('../web/vault.js')>()), getSecret: (id: string) => h.vault.get(id) ?? null }))
vi.mock('../web/agent-config.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-config.js')>()), agentDir: (n: string) => join(h.root, n) }))
vi.mock('../web/claude-cli-version.js', async (orig) => ({ ...(await orig<typeof import('../web/claude-cli-version.js')>()), measureClaudeCliVersion: async () => ({ version: null }) }))
vi.mock('../web/default-model-guard.js', async (orig) => ({ ...(await orig<typeof import('../web/default-model-guard.js')>()), launchableInstallDefault: async () => 'claude-sonnet-5' }))
vi.mock('../web/agent-create.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-create.js')>()),
  createAgentFromSpec: async (data: Record<string, unknown>) => { h.creates.push(data); h.onCreate?.(); return { status: h.createAnswer.status, body: { ...h.createAnswer.body, name: data.name } } },
}))
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
const { tryHandleApprovals, _setAgentCreateNotifierForTest } = await import('../web/routes/approvals.js')
const { registerAgentCreateConsumer, sweepAgentCreateOnStart, consumeAgentCreate } = await import('../web/agent-create-approval.js')
registerAgentCreateConsumer()

const TOKEN = ['123456', ':AAH', 'fakefakefakefakefakefake'].join('')
const SPEC = { spec_version: 1, name: 'Kutato', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default', channel: { provider: 'telegram', botToken: { vault_ref: 'TG-KUTATO' } } }
const OWNER = { channel: 'teams', mode: 'card' } as const

async function call(method: string, path: string, body: unknown, auth: Record<string, unknown> = { kind: 'token', agent: 'samu' }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = { 'x-agent-id': String((auth as { agent?: string }).agent ?? 'samu') }
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  await tryHandleApprovals({ req, res, path, method, url, auth } as any)
  return out
}
const file = () => call('POST', '/api/agent-specs', SPEC)
const specRow = (id: string) => db.getDb().prepare('SELECT * FROM agent_create_specs WHERE approval_id = ?').get(id) as Record<string, any> | undefined
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  db.initDatabase(':memory:')
  h.vault = new Map([['TG-KUTATO', TOKEN]])
  h.creates.length = 0
  h.alerts.length = 0
  h.createAnswer = { status: 200, body: { ok: true } }
  h.settings = { AGENT_CREATE_VIA_APPROVAL: 'on' }
  h.channelSetups.length = 0
  h.channelAnswer = { status: 200, body: { ok: true } }
  h.onCreate = null
  h.acl = { 'TG-KUTATO': ['samu'] }
})

describe('POST /api/agent-specs files a request, never an agent', () => {
  it('with the switch off: 403, nothing stored', async () => {
    h.settings.AGENT_CREATE_VIA_APPROVAL = 'off'
    const r = await file()
    expect(r.status).toBe(403)
    expect(db.listApprovals({ category: 'agent_create' })).toEqual([])
  })

  it('on, with the shared token: 201, a pending agent_create approval bound to the spec hash, the server-rendered text, and NO create', async () => {
    const r = await call('POST', '/api/agent-specs', SPEC, { kind: 'token', agent: 'samu' })
    expect(r.status).toBe(201)
    const a = db.getApproval(r.body.approvalId)!
    expect([a.category, a.status, a.content_hash, a.agent_id]).toEqual(['agent_create', 'pending', r.body.contentHash, 'samu'])
    // Dani #2940 B1: the owner's text stays with the approval, the requester gets the id and the hash only
    expect(Object.keys(r.body).sort()).toEqual(['approvalId', 'contentHash', 'ok'])
    expect(a.action_description).toContain('bot-token: beállítva (vault: TG-KUTATO)')
    expect(a.action_description).not.toContain(TOKEN)
    expect(specRow(a.id)!.content_hash).toBe(a.content_hash)
    await settle()
    expect(h.creates).toEqual([])
  })

  it('a refused spec: its status and error, nothing stored', async () => {
    const r = await call('POST', '/api/agent-specs', { ...SPEC, invite: 'x' })
    expect(r).toEqual({ status: 400, body: { error: 'unknown field: invite' } })
    expect(db.listApprovals({ category: 'agent_create' })).toEqual([])
  })
})

describe('the vault entry a spec may name (Dani #2922 B1) and the open-request cap (n1)', () => {
  const tg = (ref: string) => ({ ...SPEC, channel: { provider: 'telegram', botToken: { vault_ref: ref } } })
  const UNUSABLE = (ref: string) => ({ status: 400, body: { error: `channel.botToken.vault_ref cannot be used: ${ref}` } })

  it('an id the claimed agent is not listed for: refused with exactly the answer a missing id gets; nothing stored', async () => {
    h.vault.set('MASIKE', TOKEN); h.acl['MASIKE'] = ['dani']
    expect(await call('POST', '/api/agent-specs', tg('MASIKE'))).toEqual(UNUSABLE('MASIKE'))
    expect(await call('POST', '/api/agent-specs', tg('NINCS-ILYEN'))).toEqual(UNUSABLE('NINCS-ILYEN'))
    h.vault.set('NINCS-LISTAN', TOKEN)
    expect(await call('POST', '/api/agent-specs', tg('NINCS-LISTAN'))).toEqual(UNUSABLE('NINCS-LISTAN'))
    expect(db.listApprovals({ category: 'agent_create' })).toEqual([])
  })

  it('SSH material is never usable, even when the list names the agent', async () => {
    h.vault.set('ssh-key-1', TOKEN); h.acl['ssh-key-1'] = ['samu']
    expect(await call('POST', '/api/agent-specs', tg('ssh-key-1'))).toEqual(UNUSABLE('ssh-key-1'))
  })

  it('the shared token without a claimed name: no vault entry is usable', async () => {
    expect(await call('POST', '/api/agent-specs', tg('TG-KUTATO'), { kind: 'token' })).toEqual(UNUSABLE('TG-KUTATO'))
  })

  it('an agent\'s own token is held to its own name; the owner session may name any entry', async () => {
    expect((await call('POST', '/api/agent-specs', tg('TG-KUTATO'), { kind: 'token', agent: 'dani', tokenAgent: 'samu' })).status).toBe(201)
    expect(await call('POST', '/api/agent-specs', tg('TG-KUTATO'), { kind: 'token', agent: 'samu', tokenAgent: 'dani' })).toEqual(UNUSABLE('TG-KUTATO'))
    h.vault.set('GAZDA-BOT', TOKEN)
    expect((await call('POST', '/api/agent-specs', tg('GAZDA-BOT'), { kind: 'session', user: 'owner' })).status).toBe(201)
  })

  it('ten requests from one requester at once: exactly three filed, the rest 429 (Dani 81221: the count and the insert are one step)', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/api/agent-specs', { ...SPEC, name: `Egyszerre${i}` })))
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3)
    expect(rs.filter((r) => r.status === 429)).toHaveLength(7)
    expect(db.listApprovals({ category: 'agent_create', status: 'pending' })).toHaveLength(3)
  })

  it('SSH material is not usable from the owner session either (the floor holds for everyone)', async () => {
    h.vault.set('ssh-key-2', TOKEN)
    expect(await call('POST', '/api/agent-specs', tg('ssh-key-2'), { kind: 'session', user: 'owner' })).toEqual(UNUSABLE('ssh-key-2'))
  })

  it('at most twenty open requests in all, whoever asks: the twenty-first is 429', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', '/api/agent-specs', { ...SPEC, name: `Ossz${i}`, channel: undefined }, { kind: 'token', agent: `ugynok${Math.floor(i / 3)}` })
      expect(r.status).toBe(201)
    }
    expect((await call('POST', '/api/agent-specs', { ...SPEC, name: 'Ossz99', channel: undefined }, { kind: 'token', agent: 'ujkero' })).status).toBe(429)
  })

  it('at most three open requests per requester: the fourth is 429, and a decided one frees a place', async () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await call('POST', '/api/agent-specs', { ...SPEC, name: `Kutato${i}` })).body.approvalId)
    expect((await call('POST', '/api/agent-specs', { ...SPEC, name: 'Kutato9' })).status).toBe(429)
    db.decideApproval({ approvalId: ids[0], status: 'rejected', evidence: OWNER })
    expect((await call('POST', '/api/agent-specs', { ...SPEC, name: 'Kutato9' })).status).toBe(201)
  })
})

describe('the decision and the consumer', () => {
  it('approved with the shown hash: consumed once, the spec re-checked, the agent created through createAgentFromSpec, the outcome written', async () => {
    const { body } = await file()
    expect(db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash }).outcome).toBe('decided')
    await settle()
    expect(h.creates).toEqual([{ name: 'Kutato', description: 'Piackutatás', model: 'claude-sonnet-5', profile: 'default', customProvider: null }])
    const a = db.getApproval(body.approvalId)!
    expect([a.consumed_by, a.consumed_ref]).toEqual(['agent_create', body.approvalId])
    expect(h.channelSetups).toEqual([['kutato', 'telegram', { botToken: TOKEN }]])
    expect(specRow(body.approvalId)).toMatchObject({ outcome: 'created', created_agent: 'kutato' })
    expect(specRow(body.approvalId)!.consumed_at).not.toBeNull()
    expect(h.alerts).toEqual([])
  })

  it('an approval without the shown hash, or with another one: nothing decided, nothing created', async () => {
    const { body } = await file()
    expect(db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER }).outcome).toBe('content_changed')
    expect(db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: 'f'.repeat(64) }).outcome).toBe('content_changed')
    await settle()
    expect(h.creates).toEqual([])
  })

  it('a rejection creates nothing', async () => {
    const { body } = await file()
    db.decideApproval({ approvalId: body.approvalId, status: 'rejected', evidence: OWNER })
    await settle()
    expect(h.creates).toEqual([])
    expect(specRow(body.approvalId)!.consumed_at).toBeNull()
  })

  it('an expired request is not approved', async () => {
    const { body } = await file()
    db.getDb().prepare('UPDATE approvals SET timeout_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, body.approvalId)
    expect(db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash }).outcome).toBe('expired')
    await settle()
    expect(h.creates).toEqual([])
  })

  it('a spec changed after the approval: consumed, refused, nothing created, the main agent alerted', async () => {
    const { body } = await file()
    db.getDb().prepare("UPDATE agent_create_specs SET spec_json = replace(spec_json, '\"default\"', '\"admin\"') WHERE approval_id = ?").run(body.approvalId)
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    expect(h.creates).toEqual([])
    expect(specRow(body.approvalId)!.outcome).toBe('refused:hash_mismatch')
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('hash_mismatch')
  })

  it('a vault value swapped after the approval: refused, nothing created, alerted', async () => {
    const { body } = await file()
    h.vault.set('TG-KUTATO', TOKEN + 'x')
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    expect(h.creates).toEqual([])
    expect(specRow(body.approvalId)!.outcome).toBe('refused:vault_value_changed')
    expect(h.alerts).toHaveLength(1)
  })

  it('a second consume of the same approval creates nothing more and alerts nothing', async () => {
    const { body } = await file()
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    await consumeAgentCreate(db.getApproval(body.approvalId)!)
    expect(h.creates).toHaveLength(1)
    expect(h.alerts).toEqual([])
  })

  it('a create the dashboard code refuses: the outcome names it, the main agent is alerted', async () => {
    h.createAnswer = { status: 409, body: { error: 'Agent already exists' } }
    const { body } = await file()
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    expect(specRow(body.approvalId)!.outcome).toBe('failed:409:Agent already exists')
    expect(h.alerts).toHaveLength(1)
  })
})

describe('the channel, after the create', () => {
  it('a channel setup that fails: the agent stays, the outcome names it, the main agent is alerted', async () => {
    h.channelAnswer = { status: 400, body: { error: 'Unauthorized' } }
    const { body } = await file()
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    expect(h.creates).toHaveLength(1)
    expect(specRow(body.approvalId)).toMatchObject({ outcome: 'created_channel_failed:400:Unauthorized', created_agent: 'kutato' })
    expect(h.alerts).toHaveLength(1)
  })

  it('a vault value swapped between the consume and the channel setup: no channel, refused, alerted', async () => {
    const { body } = await file()
    h.onCreate = () => { h.vault.set('TG-KUTATO', TOKEN + 'x') }
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    expect(h.creates).toHaveLength(1)
    expect(h.channelSetups).toEqual([])
    expect(specRow(body.approvalId)!.outcome).toBe('created_channel_refused:vault_value_changed')
    expect(h.alerts).toHaveLength(1)
  })

  it('a spec without a channel sets none up', async () => {
    const { body } = await call('POST', '/api/agent-specs', { ...SPEC, channel: undefined })
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    expect(h.channelSetups).toEqual([])
    expect(specRow(body.approvalId)!.outcome).toBe('created')
  })
})

describe('the dashboard: the owner session approves with the hash it was shown (Samu 81167)', () => {
  const patch = (id: string, data: Record<string, unknown>, auth: Record<string, unknown>) => call('PATCH', `/api/approvals/${id}`, data, auth)
  const OWNER_SESSION = { kind: 'session', user: 'owner' }

  it('the owner session with the shown hash: approved through the core (dashboard_owner), the agent created', async () => {
    const { body } = await file()
    const r = await patch(body.approvalId, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, OWNER_SESSION)
    expect(r.status).toBe(200)
    expect([r.body.status, r.body.resolved_by]).toEqual(['approved', 'dashboard_owner'])
    await settle()
    expect(h.creates).toHaveLength(1)
    expect(specRow(body.approvalId)!.outcome).toBe('created')
  })

  it('the owner session without the hash: 400; with another hash: 409; nothing decided or created', async () => {
    const { body } = await file()
    expect((await patch(body.approvalId, { status: 'approved', resolved_by: 'dashboard' }, OWNER_SESSION)).status).toBe(400)
    const r = await patch(body.approvalId, { status: 'approved', resolved_by: 'dashboard', content_hash: 'e'.repeat(64) }, OWNER_SESSION)
    expect(r).toEqual({ status: 409, body: { error: 'Not approved: content_changed' } })
    await settle()
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(h.creates).toEqual([])
  })

  it.each([
    ['the shared token (also the first-run and install path: no owner session beside it)', { kind: 'token', agent: 'samu' }],
    ['a sub-agent\'s own token', { kind: 'token', agent: 'samu', tokenAgent: 'samu' }],
    ['an operator device key', { kind: 'device', scope: 'operator', device: 'bridge' }],
    ['a full device key without the owner session', { kind: 'device', scope: 'full', device: 'bridge' }],
  ])('%s: 403, nothing decided', async (_, auth) => {
    const { body } = await file()
    const r = await patch(body.approvalId, { status: 'approved', resolved_by: 'x', content_hash: body.contentHash }, auth)
    expect(r.status).toBe(403)
    await settle()
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(h.creates).toEqual([])
  })

  it('a rejection stays a status write', async () => {
    const { body } = await file()
    const r = await patch(body.approvalId, { status: 'rejected', resolved_by: 'dashboard' }, { kind: 'token', agent: 'samu' })
    expect(r.status).toBe(200)
    expect(db.getApproval(body.approvalId)!.status).toBe('rejected')
  })
})

describe('the start-up sweep', () => {
  it('an approved, unconsumed request (decided while the consumer could not run) is consumed and created now', async () => {
    const { body } = await file()
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'teams_card' WHERE id = ?").run(Math.floor(Date.now() / 1000), body.approvalId)
    expect(await sweepAgentCreateOnStart()).toEqual({ consumed: 1, interrupted: 0 })
    expect(h.creates).toHaveLength(1)
    expect(specRow(body.approvalId)!.outcome).toBe('created')
  })

  it('consumed but without an outcome (a crash in between): marked interrupted and alerted, never re-run', async () => {
    const { body } = await file()
    db.getDb().prepare('UPDATE agent_create_specs SET consumed_at = ? WHERE approval_id = ?').run(Math.floor(Date.now() / 1000), body.approvalId)
    expect(await sweepAgentCreateOnStart()).toEqual({ consumed: 0, interrupted: 1 })
    expect(h.creates).toEqual([])
    expect(specRow(body.approvalId)!.outcome).toBe('interrupted')
    expect(h.alerts).toHaveLength(1)
  })

  it('a request already consumed and created is not swept again: zero, and no second create', async () => {
    const { body } = await file()
    db.decideApproval({ approvalId: body.approvalId, status: 'approved', evidence: OWNER, expectedContentHash: body.contentHash })
    await settle()
    expect(await sweepAgentCreateOnStart()).toEqual({ consumed: 0, interrupted: 0 })
    expect(h.creates).toHaveLength(1)
  })

  it('nothing to do: zero and zero', async () => {
    await file()
    expect(await sweepAgentCreateOnStart()).toEqual({ consumed: 0, interrupted: 0 })
  })
})

describe('the server wires the consumer and the sweep at start', () => {
  it('web.ts registers the agent_create consumer and runs the start-up sweep, after the approval sweepers', async () => {
    const { readFileSync } = await import('node:fs')
    const WEB = readFileSync(new URL('../web.ts', import.meta.url), 'utf-8')
    const sweepers = WEB.indexOf('const approvalReactionInterval = startApprovalReactionSweeper()')
    const register = WEB.indexOf('  registerAgentCreateConsumer()\n')
    const sweep = WEB.indexOf('  void sweepAgentCreateOnStart().catch(')
    expect(sweepers).toBeGreaterThan(-1)
    expect(register).toBeGreaterThan(sweepers)
    expect(sweep).toBeGreaterThan(register)
  })
})

describe('the dashboard button (source contract)', () => {
  it('approving an agent_create shows the whole server-rendered text and its check code, and sends back the row\'s hash', async () => {
    const { readFileSync } = await import('node:fs')
    const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
    const fn = APP.slice(APP.indexOf('async function _resolveApproval(id, decision) {'), APP.indexOf('// === Settings (central config registry) ==='))
    expect(fn).toContain("if (row && row.category === 'agent_create' && decision === 'approved') {")
    expect(fn).toContain('pre.textContent = row.action_description')
    expect(fn).toContain("t('approvals.agent_create.confirm_message', { code: String(row.content_hash || '').slice(0, 8) })")
    expect(fn).toContain('if (!ok) return')
    expect(fn).toContain('payload.content_hash = row.content_hash')
    expect(fn).toContain('body: JSON.stringify(payload),')
    for (const lang of ['hu', 'en']) {
      const L = readFileSync(new URL(`../../web/lang/${lang}.js`, import.meta.url), 'utf-8')
      for (const k of ['confirm_title', 'confirm_message', 'confirm_ok']) expect(L).toContain(`'approvals.agent_create.${k}':`)
    }
  })
})

// AGENTCREATEPR3-1119 (Samu 81756, 1): a filed request asks the owner on the channels, with the server's text; a delivery
// that fails does not undo the filing.
describe('the owner is asked on the channels after the filing', () => {
  it('a filed request: the notifier gets the pending approval once, with the server-rendered text', async () => {
    const seen: Array<{ id: string; status: string; text: string }> = []
    _setAgentCreateNotifierForTest((a) => { seen.push({ id: a.id, status: a.status, text: a.action_description }) })
    try {
      const r = await file()
      expect(r.status).toBe(201)
      expect(seen).toEqual([{ id: r.body.approvalId, status: 'pending', text: db.getApproval(r.body.approvalId)!.action_description }])
      expect(seen[0].text).toContain('bot-token: beállítva (vault: TG-KUTATO)')
    } finally { _setAgentCreateNotifierForTest(null) }
  })
  it('a notifier that throws: still 201, the request pending on the dashboard, nothing created', async () => {
    _setAgentCreateNotifierForTest(() => { throw new Error('channel down') })
    try {
      const r = await file()
      expect(r.status).toBe(201)
      expect(db.getApproval(r.body.approvalId)!.status).toBe('pending')
      await settle()
      expect(h.creates).toEqual([])
    } finally { _setAgentCreateNotifierForTest(null) }
  })
  it('a refused spec asks nobody', async () => {
    const seen: string[] = []
    _setAgentCreateNotifierForTest((a) => { seen.push(a.id) })
    try {
      const r = await call('POST', '/api/agent-specs', { ...SPEC, profile: 'nincs-ilyen' })
      expect(r.status).toBe(400)
      expect(seen).toEqual([])
    } finally { _setAgentCreateNotifierForTest(null) }
  })
})
