// DASHOPERATOR1005 PR-3: the /api/operator/* endpoints. Each capability is
// closed while the owner's switch is off; responses are projections (no
// content field, no vault value); forwarded writes carry no owner option; a
// command is a name from the owner's list mapped to a fixed text; the operator
// signs in with a key and gets an HttpOnly cookie that dies with the key.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const h = vi.hoisted(() => ({
  access: null as any,
  secrets: new Map<string, { label: string; value: string }>(),
  notified: [] as string[],
  forwarded: [] as Array<{ handler: string; path: string; body: string }>,
  prompts: [] as Array<{ session: string; text: string }>,
  sendResult: 'sent' as string,
  audit: [] as Array<{ key: string; newValue: unknown; actor: string }>,
  mainId: '',
}))

vi.mock('../web/operator-access.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readOperatorAccess: () => h.access,
}))
vi.mock('../db.js', async (orig) => {
  const real = await orig<Record<string, any>>()
  return {
    ...real,
    logConfigChange: (key: string, _old: unknown, newValue: unknown, actor: string) => { h.audit.push({ key, newValue, actor }) },
  }
})
vi.mock('../web/vault.js', () => ({
  // `value` stands for a field added upstream later: the operator list must project it away.
  listSecrets: () => [...h.secrets.entries()].map(([id, s]) => ({ id, label: s.label, createdAt: '2026-10-01', updatedAt: '2026-10-02', value: s.value })),
  setSecret: (id: string, label: string, value: string) => { h.secrets.set(id, { label, value }) },
}))
vi.mock('../web/vault-bindings.js', () => ({ syncSecret: () => ({ updated: 0 }) }))
vi.mock('../notify.js', () => ({ notifySecurityEvent: async (t: string) => { h.notified.push(t) } }))

async function recordForward(handler: string, ctx: any): Promise<boolean> {
  const chunks: Buffer[] = []
  for await (const c of ctx.req) chunks.push(Buffer.from(c))
  h.forwarded.push({ handler, path: ctx.path, body: Buffer.concat(chunks).toString() })
  ctx.res.writeHead(200); ctx.res.end(JSON.stringify({ ok: true }))
  return true
}

vi.mock('../web/routes/agents.js', () => ({
  tryHandleAgents: (ctx: any) => recordForward('agents', ctx),
  listAgentSummaries: () => [{
    name: 'samu', displayName: 'Samu', running: true, runState: 'running', model: 'm', activeModel: 'm', runningSince: 1,
    contextTokens: 1000, needsReauth: false,
    // content fields that must never reach the operator
    description: 'SECRET-DESCRIPTION', claudeMd: 'SECRET-CLAUDEMD', telegramBotUsername: 'secret_bot', team: { role: 'x' },
  }],
}))
vi.mock('../web/routes/agent-terminal.js', () => ({
  tryHandleAgentTerminal: async (ctx: any) => { h.forwarded.push({ handler: 'terminal', path: ctx.path, body: '' }); ctx.res.writeHead(200); ctx.res.end('{}'); return true },
}))
vi.mock('../web/routes/updates.js', () => ({ tryHandleUpdates: (ctx: any) => recordForward('updates', ctx) }))
const UPDATE = { current: 'abc', version: '1.2.3', latest: 'def', behind: 2, commits: [{ sha: 'x', message: 'SECRET-COMMIT' }], remote: 'https://tok@github.com/x', lastChecked: 5, error: 'fatal: https://tok@github.com' }
vi.mock('../web/update-checker.js', () => ({ getUpdateStatus: () => UPDATE, refreshUpdateStatus: async () => UPDATE }))
vi.mock('../web/routes/overview.js', () => ({
  readFleetQuota: () => ({ status: 'ok', ageSec: 1, maxAgeSec: 9, fiveHour: null, sevenDay: { usedPercentage: 20, resetsAt: null, expired: false, sourceAgent: 'SECRET-AGENT' }, source: 'mod', sourceAgents: ['samu'] }),
}))
vi.mock('../web/system-status.js', () => ({
  getSystemStatus: async () => ({
    generatedAt: 1,
    blocks: [
      { title: 'CSATORNA', rows: [
        { label: 'Párosítás', value: '@secret_bot · tulajdonos chat: 12345', source: 's' },
        { label: 'Forgalom', value: 'bejövő 10:00', source: 's' },
      ] },
      { title: 'ÜTEMEZŐ (24 óra)', rows: [{ label: 'Körök', value: '3 ok', source: 's' }, { label: 'Következő', value: 'secret-task 11:00', source: 's' }] },
      { title: 'ÚJ BLOKK', rows: [{ label: 'Bármi', value: 'unlisted', source: 's' }] },
    ],
  }),
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ...(await (async () => { const { MAIN_AGENT_ID: mainId } = await import('../config.js'); h.mainId = mainId; return {} })()),
  // The real isKnownAgent also answers TRUE for names that resolve to the agents/
  // base itself ('./', 'x/..', 'samu/..': safeJoin allows the exact base), so the
  // mock does too -- the route's own name check must be what refuses them.
  isKnownAgent: (n: string) => ['samu', 'marveen', './', 'x/..', 'samu/..'].includes(n) || n === h.mainId,
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  agentSessionName: (n: string) => `agent-${n}`,
  isAgentRunning: () => true,
  capturePane: () => 'pane',
  sendPromptToSession: async (session: string, text: string) => { h.prompts.push({ session, text }); return h.sendResult },
}))

import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { createDeviceKey, revokeDeviceKey, _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import { resolveAuth, requiresAuth } from '../web/auth-gate.js'
import { defaultOperatorAccess, OPERATOR_CAPABILITIES, type OperatorAccess } from '../web/operator-access.js'
import { _clearOperatorSessionsForTest, OPERATOR_COOKIE_NAME } from '../web/operator-sessions.js'
import { OPERATOR_AGENT_FIELDS, OPERATOR_COMMAND_TEXT, tryHandleOperator } from '../web/routes/operator.js'
import type { RouteContext } from '../web/routes/types.js'

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  _clearDeviceKeyCacheForTest()
  _clearOperatorSessionsForTest()
  h.access = allOn()
  h.secrets.clear()
  h.notified.length = 0
  h.forwarded.length = 0
  h.prompts.length = 0
  h.audit.length = 0
  h.sendResult = 'sent'
})

function allOn(): OperatorAccess {
  const a = defaultOperatorAccess()
  a.enabled = true
  for (const c of OPERATOR_CAPABILITIES) a.capabilities[c] = true
  a.commands = ['login', 'mcp']
  return a
}

const OPERATOR = { kind: 'device', device: 'it-op', deviceId: 7, scope: 'operator' } as RouteContext['auth']

async function call(method: string, path: string, opts: { body?: unknown; auth?: RouteContext['auth']; cookie?: string } = {}) {
  const out: { status: number; body: any; raw: string; headers: Record<string, string> } = { status: 0, body: null, raw: '', headers: {} }
  const res: any = {
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v; return res },
    writeHead(s: number, hd?: Record<string, string>) { out.status = s; for (const [k, v] of Object.entries(hd ?? {})) out.headers[k.toLowerCase()] = v; return res },
    end(c?: string) { if (c) { out.raw = String(c); try { out.body = JSON.parse(String(c)) } catch { out.body = c } } },
  }
  const req: any = Readable.from([Buffer.from(opts.body === undefined ? '' : JSON.stringify(opts.body))])
  req.headers = { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie } : {}) }
  req.socket = { remoteAddress: '10.0.0.9' }
  const ctx = { req, res, path, method, url: new URL(`http://localhost${path}`), auth: 'auth' in opts ? opts.auth : OPERATOR } as RouteContext
  const handled = await tryHandleOperator(ctx, '/nonexistent-web-dir')
  return { handled, ...out }
}

// Every field name anywhere in a JSON value.
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out) }
  return out
}

const CAPABILITY_ENDPOINTS: Array<[string, string, string]> = [
  ['agentControl', 'POST', '/api/operator/agents/samu/start'],
  ['agentControl', 'POST', '/api/operator/agents/samu/stop'],
  ['agentControl', 'POST', '/api/operator/agents/samu/restart'],
  ['update', 'POST', '/api/operator/updates/check'],
  ['update', 'POST', '/api/operator/updates/apply'],
  ['vaultWrite', 'GET', '/api/operator/vault'],
  ['vaultWrite', 'PUT', '/api/operator/vault/OPENAI_KEY'],
  ['paneView', 'GET', '/api/operator/agents/samu/pane/stream'],
  ['commands', 'POST', '/api/operator/agents/samu/commands/login'],
]

describe('who may call /api/operator/*', () => {
  it('only an operator credential: token, session, full key and federation get 403', async () => {
    for (const auth of [{ kind: 'token' }, { kind: 'session', user: 'owner' }, { kind: 'device', scope: 'full', device: 'phone', deviceId: 1 }, { kind: 'federation', peer: 'p' }, undefined] as RouteContext['auth'][]) {
      const r = await call('GET', '/api/operator/status', { auth })
      expect(r.status).toBe(403)
    }
  })

  it('an unknown operator path is answered HERE (404), never left to fall through to an owner route', async () => {
    for (const p of ['/api/operator/vault/OPENAI_KEY', '/api/operator/agents/samu/keys', '/api/operator/anything']) {
      const r = await call('GET', p)
      expect(r.handled).toBe(true)
      expect(r.status).toBe(404)
    }
  })

  it('the login is public; every other operator path needs a credential', () => {
    expect(requiresAuth('/api/operator/login', 'POST')).toBe(false)
    expect(requiresAuth('/api/operator/login', 'GET')).toBe(true)
    expect(requiresAuth('/api/operator/status', 'GET')).toBe(true)
  })
})

describe('the owner switches close their endpoints', () => {
  it.each(CAPABILITY_ENDPOINTS)('%s OFF -> 403 on %s %s', async (cap, method, path) => {
    h.access.capabilities[cap as keyof OperatorAccess['capabilities']] = false
    const r = await call(method, path, { body: method === 'PUT' ? { value: 'v' } : undefined })
    expect(r.status).toBe(403)
    expect(r.body.capability).toBe(cap)
    expect(h.forwarded).toEqual([])
    expect(h.prompts).toEqual([])
    expect(h.secrets.size).toBe(0)
  })

  it.each(CAPABILITY_ENDPOINTS)('%s ON -> %s %s goes through', async (_cap, method, path) => {
    const r = await call(method, path, { body: method === 'PUT' ? { value: 'v' } : undefined })
    expect(r.status).toBe(200)
  })
})

describe('forwarded actions', () => {
  it('start/stop/restart reach the owner route on a fixed path, with the body dropped', async () => {
    for (const action of ['start', 'stop', 'restart']) {
      await call('POST', `/api/operator/agents/samu/${action}`, { body: { fresh: true } })
    }
    expect(h.forwarded).toEqual([
      { handler: 'agents', path: '/api/agents/samu/start', body: '' },
      { handler: 'agents', path: '/api/agents/samu/stop', body: '' },
      { handler: 'agents', path: '/api/agents/samu/restart', body: '' },
    ])
    expect(h.audit.map(a => a.key)).toEqual(['operator:agent-start', 'operator:agent-stop', 'operator:agent-restart'])
    expect(h.audit[0]!.actor).toBe('operator:it-op#7')
  })

  it('a name that resolves to the agents/ base (and that isKnownAgent accepts) is a 404 and forwards nothing', async () => {
    for (const raw of ['.%2F', 'x%2F..', 'samu%2F..']) {
      for (const action of ['restart', 'stop', 'start']) {
        expect((await call('POST', `/api/operator/agents/${raw}/${action}`)).status, `${raw} ${action}`).toBe(404)
      }
      expect((await call('POST', `/api/operator/agents/${raw}/commands/login`)).status).toBe(404)
      expect((await call('GET', `/api/operator/agents/${raw}/pane/stream`)).status).toBe(404)
    }
    expect(h.forwarded).toEqual([])
    expect(h.prompts).toEqual([])
  })

  it('the main agent: restart needs its own switch (not agentControl); start/stop are 400', async () => {
    const main = encodeURIComponent(MAIN_AGENT_ID)
    h.access.capabilities.mainAgentRestart = false
    const off = await call('POST', `/api/operator/agents/${main}/restart`)
    expect(off.status).toBe(403)
    expect(off.body.capability).toBe('mainAgentRestart')
    for (const action of ['start', 'stop']) expect((await call('POST', `/api/operator/agents/${main}/${action}`)).status).toBe(400)
    expect(h.forwarded).toEqual([])
    h.access.capabilities.mainAgentRestart = true
    h.access.capabilities.agentControl = false
    expect((await call('POST', `/api/operator/agents/${main}/restart`)).status).toBe(200)
    expect(h.forwarded).toEqual([{ handler: 'agents', path: `/api/agents/${main}/restart`, body: '' }])
    // and agentControl alone never reaches the main agent
    h.forwarded.length = 0
    h.access.capabilities.mainAgentRestart = false
    h.access.capabilities.agentControl = true
    expect((await call('POST', `/api/operator/agents/${main}/restart`)).status).toBe(403)
    expect(h.forwarded).toEqual([])
  })

  it('overwriting an existing secret needs vaultOverwrite; vaultWrite alone only creates', async () => {
    h.secrets.set('OPENAI_KEY', { label: 'OpenAI', value: 'old' })
    h.access.capabilities.vaultOverwrite = false
    const r = await call('PUT', '/api/operator/vault/OPENAI_KEY', { body: { value: 'new' } })
    expect(r.status).toBe(403)
    expect(r.body.capability).toBe('vaultOverwrite')
    expect(h.secrets.get('OPENAI_KEY')!.value).toBe('old')
    expect(h.notified).toEqual([])
    expect(h.audit).toEqual([])
    // a new id still goes through on vaultWrite alone
    expect((await call('PUT', '/api/operator/vault/NEW_ONE', { body: { value: 'v' } })).status).toBe(200)
    expect(h.secrets.get('NEW_ONE')!.value).toBe('v')
    // and vaultOverwrite without vaultWrite opens nothing
    h.access.capabilities.vaultWrite = false
    h.access.capabilities.vaultOverwrite = true
    expect((await call('PUT', '/api/operator/vault/OPENAI_KEY', { body: { value: 'x' } })).status).toBe(403)
    expect(h.secrets.get('OPENAI_KEY')!.value).toBe('old')
  })

  it('ssh pool ids stay refused with every vault switch on', async () => {
    expect((await call('PUT', '/api/operator/vault/ssh-key-abc', { body: { value: 'x' } })).status).toBe(400)
  })

  it('a new secret says so in the owner notification', async () => {
    await call('PUT', '/api/operator/vault/NEW_KEY', { body: { value: 'v' } })
    expect(h.notified[0]).toContain('új titok létrehozva')
    expect(h.notified[0]).not.toContain('MEGLÉVŐ')
  })

  it('an unknown or malformed agent name is a 404 and forwards nothing', async () => {
    for (const p of ['/api/operator/agents/nobody/restart', '/api/operator/agents/..%2Fx/restart', '/api/operator/agents/%E0/restart']) {
      const r = await call('POST', p)
      expect(r.status).toBe(404)
    }
    expect(h.forwarded).toEqual([])
  })

  it('update apply is forwarded without the auto-stash option', async () => {
    await call('POST', '/api/operator/updates/apply', { body: { autoStash: true } })
    expect(h.forwarded).toEqual([{ handler: 'updates', path: '/api/updates/apply', body: '' }])
  })

  it('update check answers the projection, not the commit list or the error text', async () => {
    const r = await call('POST', '/api/operator/updates/check')
    expect(r.raw).not.toContain('SECRET-COMMIT')
    expect(r.raw).not.toContain('tok@')
    expect(r.body).toMatchObject({ version: '1.2.3', behind: 2, checkFailed: true })
  })

  it('the pane stream reaches the owner stream on a fixed path and is audited', async () => {
    await call('GET', '/api/operator/agents/samu/pane/stream')
    expect(h.forwarded).toEqual([{ handler: 'terminal', path: '/api/agents/samu/pane/stream', body: '' }])
    expect(h.audit.map(a => a.key)).toEqual(['operator:pane-view'])
  })
})

describe('status: a projection with no content field', () => {
  const CONTENT = ['description', 'tail', 'text', 'claudeMd', 'soulMd', 'mcpJson', 'prompt', 'commits', 'releases', 'remote', 'sourceAgents', 'sourceAgent', 'telegramBotUsername', 'team', 'value_raw']

  it('no content field anywhere in the response, and the agent rows carry the listed fields only', async () => {
    const r = await call('GET', '/api/operator/status')
    expect(r.status).toBe(200)
    const keys = keysDeep(r.body)
    for (const k of CONTENT) expect(keys.has(k), k).toBe(false)
    expect(Object.keys(r.body.agents[0]).sort()).toEqual([...OPERATOR_AGENT_FIELDS, 'isMain'].sort())
    for (const s of ['SECRET-AGENT', 'SECRET-DESCRIPTION', 'SECRET-CLAUDEMD', 'secret_bot', 'SECRET-COMMIT', 'tok@', '12345', 'secret-task', 'unlisted']) {
      expect(r.raw, s).not.toContain(s)
    }
  })

  it('health keeps the listed rows only: no pairing row (bot + owner chat), no unlisted block', async () => {
    const r = await call('GET', '/api/operator/status')
    expect(r.body.health).toEqual([
      { title: 'CSATORNA', rows: [{ label: 'Forgalom', value: 'bejövő 10:00' }] },
      { title: 'ÜTEMEZŐ (24 óra)', rows: [{ label: 'Körök', value: '3 ok' }] },
    ])
  })

  it('status is always on (no capability), but closed while the whole surface is off is the GATE\'s job', async () => {
    h.access = { ...defaultOperatorAccess(), enabled: true }
    expect((await call('GET', '/api/operator/status')).status).toBe(200)
  })
})

describe('vault: write-only', () => {
  it('the list carries names and dates, never a value', async () => {
    h.secrets.set('OPENAI_KEY', { label: 'OpenAI', value: 'sk-SECRET' })
    h.secrets.set('ssh-key-1', { label: 'ssh', value: 'PRIVATE' })
    const r = await call('GET', '/api/operator/vault')
    expect(r.body.secrets).toEqual([{ id: 'OPENAI_KEY', label: 'OpenAI', createdAt: '2026-10-01', updatedAt: '2026-10-02' }])
    expect(r.raw).not.toContain('sk-SECRET')
  })

  it('a write stores the value, never echoes it, audits it, and tells the owner without the value', async () => {
    h.secrets.set('OPENAI_KEY', { label: 'OpenAI', value: 'old' })
    const r = await call('PUT', '/api/operator/vault/OPENAI_KEY', { body: { value: 'sk-NEW-VALUE' } })
    expect(r.status).toBe(200)
    expect(r.raw).not.toContain('sk-NEW-VALUE')
    expect(h.secrets.get('OPENAI_KEY')).toEqual({ label: 'OpenAI', value: 'sk-NEW-VALUE' })
    expect(h.audit).toEqual([{ key: 'operator:vault-overwrite', newValue: 'OPENAI_KEY', actor: 'operator:it-op#7' }])
    expect(h.notified).toHaveLength(1)
    expect(h.notified[0]).toContain('OPENAI_KEY')
    expect(h.notified[0]).toContain('MEGLÉVŐ titok cserélve')
    expect(h.notified[0]).toContain('it-op')
    expect(h.notified[0]).not.toContain('sk-NEW-VALUE')
  })

  it('SSH pool entries, bad ids and empty values are refused', async () => {
    for (const [p, body] of [
      ['/api/operator/vault/ssh-key-abc', { value: 'x' }],
      ['/api/operator/vault/bad%20id', { value: 'x' }],
      ['/api/operator/vault/OK', { value: '' }],
      ['/api/operator/vault/OK', { value: 42 }],
    ] as Array<[string, unknown]>) {
      expect((await call('PUT', p, { body })).status).toBe(400)
    }
    expect(h.secrets.size).toBe(0)
    expect(h.notified).toEqual([])
  })

  it('no operator route can read a vault value (the file never imports a value reader)', () => {
    const src = readFileSync(join(__dirname, '../web/routes/operator.ts'), 'utf-8')
    expect(src).not.toMatch(/\bgetSecret\b/)
    expect(src).not.toMatch(/routes\/connectors/)
  })
})

describe('commands: a name from the owner list, a fixed text', () => {
  it('the allowed command types its fixed text into the agent pane', async () => {
    const r = await call('POST', '/api/operator/agents/samu/commands/login', { body: { text: 'rm -rf /' } })
    expect(r.status).toBe(200)
    expect(h.prompts).toEqual([{ session: 'agent-samu', text: OPERATOR_COMMAND_TEXT.login }])
    expect(OPERATOR_COMMAND_TEXT).toEqual({ login: '/login', mcp: '/mcp' })
  })

  it('a command off the owner list, or unknown, is 403 and types nothing', async () => {
    h.access.commands = ['mcp']
    for (const c of ['login', 'rm', 'clear']) {
      expect((await call('POST', `/api/operator/agents/samu/commands/${c}`)).status).toBe(403)
    }
    expect(h.prompts).toEqual([])
  })

  it('a busy pane is a 409, not a parked line', async () => {
    h.sendResult = 'aborted-busy'
    expect((await call('POST', '/api/operator/agents/samu/commands/mcp')).status).toBe(409)
  })

  it('/me lists the commands only while the commands switch is on', async () => {
    expect((await call('GET', '/api/operator/me')).body.commands).toEqual(['login', 'mcp'])
    h.access.capabilities.commands = false
    expect((await call('GET', '/api/operator/me')).body.commands).toEqual([])
  })
})

describe('operator login: key in, HttpOnly cookie out', () => {
  function cookieOf(r: { headers: Record<string, string> }): string {
    return r.headers['set-cookie']!.split(';')[0]!
  }

  it('an operator key signs in; the cookie is HttpOnly + SameSite=Strict and the key is not in the body', async () => {
    const k = createDeviceKey('it-op', { scope: 'operator', expiresInDays: 30 })
    const r = await call('POST', '/api/operator/login', { body: { key: k.key }, auth: undefined })
    expect(r.status).toBe(200)
    expect(r.headers['set-cookie']).toMatch(/^mv_operator=[^;]+; HttpOnly; SameSite=Strict; Path=\//)
    expect(r.raw).not.toContain(k.key)
    expect(r.headers['set-cookie']).not.toContain(k.key)
    // the cookie resolves to the operator key, so the gate fences it like the key itself
    const req: any = { headers: { cookie: cookieOf(r) } }
    expect(resolveAuth(req, new URL('http://x/api/vault'), '/api/vault', 'GET', 'a'.repeat(64)))
      .toMatchObject({ kind: 'device', scope: 'operator', device: 'it-op', deviceId: k.id })
  })

  it('revoking the key ends the session on the next request', async () => {
    const k = createDeviceKey('it-op2', { scope: 'operator', expiresInDays: 30 })
    const r = await call('POST', '/api/operator/login', { body: { key: k.key }, auth: undefined })
    revokeDeviceKey(k.id)
    const req: any = { headers: { cookie: cookieOf(r) } }
    expect(resolveAuth(req, new URL('http://x/api/operator/me'), '/api/operator/me', 'GET', 'a'.repeat(64)).kind).toBe('none')
  })

  it('a full key, a wrong key and an empty body are 401 and set no cookie', async () => {
    const full = createDeviceKey('phone')
    for (const body of [{ key: full.key }, { key: 'mvdk_nope' }, {}]) {
      const r = await call('POST', '/api/operator/login', { body, auth: undefined })
      expect(r.status).toBe(401)
      expect(r.headers['set-cookie']).toBeUndefined()
    }
  })

  it('with the surface off the login is refused even for a valid operator key', async () => {
    h.access = defaultOperatorAccess()
    const k = createDeviceKey('it-op3', { scope: 'operator', expiresInDays: 30 })
    const r = await call('POST', '/api/operator/login', { body: { key: k.key }, auth: undefined })
    expect(r.status).toBe(403)
    expect(r.headers['set-cookie']).toBeUndefined()
  })

  it('a browser session lasts at most 12 hours, even when the key lives longer', async () => {
    const k = createDeviceKey('it-op4', { scope: 'operator', expiresInDays: 300 })
    const r = await call('POST', '/api/operator/login', { body: { key: k.key }, auth: undefined })
    const maxAge = Number(/Max-Age=(\d+)/.exec(r.headers['set-cookie']!)![1])
    expect(maxAge).toBeGreaterThan(12 * 3600 - 5)
    expect(maxAge).toBeLessThanOrEqual(12 * 3600)
  })

  it('the cookie name is the one the gate reads', () => {
    expect(OPERATOR_COOKIE_NAME).toBe('mv_operator')
  })
})

describe('the route binding in web.ts', () => {
  const SRC = readFileSync(join(__dirname, '../web.ts'), 'utf-8')
  it('the operator router runs right after the owner switch route, before every other handler', () => {
    const chain = [...SRC.matchAll(/if \(await (tryHandle\w+)\(routeCtx/g)].map(m => m[1])
    expect(chain.slice(0, 3)).toEqual(['tryHandleAuth', 'tryHandleOperatorAccess', 'tryHandleOperator'])
  })
})

describe('the operator page (web/operator.js, web/operator.html)', () => {
  const JS = readFileSync(join(__dirname, '../../web/operator.js'), 'utf-8')
  const HTML = readFileSync(join(__dirname, '../../web/operator.html'), 'utf-8')

  it('calls /api/operator/* only', () => {
    const paths = [...JS.matchAll(/['`](\/api\/[^'`$?]*)/g)].map(m => m[1]!)
    expect(paths.length).toBeGreaterThan(5)
    expect(paths.filter(p => !p.startsWith('/api/operator/'))).toEqual([])
  })

  it('never builds markup from server data, and keeps nothing in browser storage', () => {
    expect(JS).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/)
    expect(JS).not.toMatch(/localStorage|sessionStorage|indexedDB/)
  })

  it('sends no keystrokes: no input path into a pane exists on the page', () => {
    expect(JS).not.toMatch(/\/keys\b|terminal-input/)
    expect(HTML).not.toMatch(/\/app\.js/)
  })
})

describe('the owner section (web/app.js)', () => {
  const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
  const fn = APP.slice(APP.indexOf('function renderOperatorAccessSection('), APP.indexOf('function renderCreateLoginForm('))

  it('is rendered for owner lanes only, beside the device keys', () => {
    expect(APP).toMatch(/renderDeviceKeysSection\(body\)\s*renderBridgeEnrollSection\(body\)\s*renderOperatorAccessSection\(body\)/)
  })

  it('asks before turning on the pane view, and mints operator keys with the operator scope', () => {
    expect(fn).toMatch(/dataset\.opCap === 'paneView' && ev\.target\.checked && !confirm\(t\('auth\.operator\.pane_warning'\)\)/)
    expect(fn).toMatch(/const payload = \{ name, scope: 'operator' \}/)
    // the field cannot ask for more than the server's operator ceiling (365 days)
    expect(fn).toMatch(/id="opKeyExpiry" type="number" min="1" max="365"/)
  })

  it('offers exactly the server capabilities, and every one starts OFF', () => {
    const list = /const OPERATOR_CAPS = \[([^\]]*)\]/.exec(APP)![1]!.split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean)
    expect(list).toEqual([...OPERATOR_CAPABILITIES])
    const d = defaultOperatorAccess()
    expect(d.enabled).toBe(false)
    expect(Object.values(d.capabilities).every(v => v === false)).toBe(true)
    expect(Object.keys(d.capabilities).sort()).toEqual([...OPERATOR_CAPABILITIES].sort())
    expect(d.commands).toEqual([])
  })

  it('every operator string exists in both languages', () => {
    const keys = [...new Set([...fn.matchAll(/t\('(auth\.operator\.[\w.]+)'/g)].map(m => m[1]!))].filter(k => !k.endsWith('.'))
    for (const c of ['agentControl', 'mainAgentRestart', 'update', 'vaultWrite', 'vaultOverwrite', 'paneView', 'commands']) keys.push(`auth.operator.cap.${c}`)
    expect(keys.length).toBeGreaterThan(10)
    for (const lang of ['hu', 'en']) {
      const L = readFileSync(join(__dirname, `../../web/lang/${lang}.js`), 'utf-8')
      for (const k of keys) expect(L, `${lang}: ${k}`).toContain(`'${k}':`)
    }
  })
})
