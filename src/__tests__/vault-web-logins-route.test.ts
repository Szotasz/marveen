// VAULTLOGIN1112: the web-logins vault sub-resource and the vault-login route, with the browser and the filler
// stubbed. What is pinned: an entry allows nobody until the owner names an agent; writes are the owner's; the
// password never comes back (list, create answer, login answer, log lines); a wrong password locks the entry until
// the owner unlocks it; a site's non-answer cools the entry down; the MCP output folder is emptied of what the call
// window wrote; every generic vault path refuses the web-login password.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const h = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  logs: [] as string[],
  agents: ['geri', 'dani'],
}))

vi.mock('../web/vault.js', async (orig) => ({
  ...(await orig<typeof import('../web/vault.js')>()),
  setSecret: (id: string, _label: string, value: string) => { h.vault.set(id, value) },
  getSecret: (id: string) => h.vault.get(id) ?? null,
  deleteSecret: (id: string) => h.vault.delete(id),
  listSecrets: () => [...h.vault.keys()].map((id) => ({ id, label: id, createdAt: '', updatedAt: '' })),
}))
vi.mock('../web/agent-config.js', async (orig) => ({ ...(await orig<typeof import('../web/agent-config.js')>()), listAgentNames: () => [...h.agents] }))
vi.mock('../logger.js', async (orig) => {
  const real = await orig<typeof import('../logger.js')>()
  const rec = (lvl: string) => (...a: unknown[]) => { h.logs.push(`${lvl} ${JSON.stringify(a)}`) }
  return { ...real, logger: { ...real.logger, info: rec('info'), warn: rec('warn'), error: rec('error') } }
})

const { initDatabase, getDb, getDashboardUser, createDashboardUser } = await import('../db.js')
const { tryHandleVaultWebLogins, webLoginDeps } = await import('../web/routes/vault-web-logins.js')
const { _clearSessionCacheForTest, createSession } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME, isAgentAllowed } = await import('../web/auth-gate.js')
const { isAgentReadableDecodedVaultId, isWebLoginSecretId } = await import('../web/vault-acl.js')

const SECRET = 'S3cret-web-pass-' + 'q7Zx'
const TOKEN: RouteContext['auth'] = { kind: 'token' }
const SESSION: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const claims = (agent: string): RouteContext['auth'] => ({ kind: 'token', agent })
const ownToken = (agent: string): RouteContext['auth'] => ({ kind: 'token', agent, tokenAgent: agent })

async function call(method: string, path: string, auth: RouteContext['auth'], body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = { 'content-type': 'application/json', ...headers }
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string | Buffer) { if (d !== undefined) out.body += d.toString() },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await tryHandleVaultWebLogins({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth, fedPeer: null })).toBe(true)
  return { status: out.status || 200, text: out.body, json: () => JSON.parse(out.body || '{}') as Record<string, any> }
}

let fills: Array<Record<string, unknown>> = []
let nextOutcome = 'success'
let outDir = ''
let duringFill: (() => void) | null = null

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
beforeEach(() => {
  getDb().exec('DELETE FROM vault_web_logins; DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  h.vault.clear(); h.logs.length = 0
  fills = []; nextOutcome = 'success'; duringFill = null
  outDir = mkdtempSync(join(tmpdir(), 'vl-out-'))
  webLoginDeps.ensureBrowser = async () => 'http://127.0.0.1:9400'
  webLoginDeps.fill = async (req) => { fills.push({ ...req }); duringFill?.(); return { outcome: nextOutcome as never } }
  webLoginDeps.outputDir = () => outDir
  webLoginDeps.syncMcp = async () => []
})

async function create(extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/api/vault/web-logins', SESSION, { origin: 'https://shop.example.com', username: 'owner@example.com', password: SECRET, ...extra })
  expect(r.status).toBe(201)
  return r.json().login as Record<string, any>
}

describe('an entry allows nobody until the owner names an agent', () => {
  it('a new entry has an empty allowedAgents list, and no agent can log in with it', async () => {
    const e = await create()
    expect(e.allowedAgents).toEqual([])
    for (const agent of h.agents) {
      const r = await call('POST', `/api/vault/web-logins/${e.id}/login`, claims(agent))
      expect(r.status).toBe(403)
      expect(r.json().outcome).toBe('not-allowed')
    }
    expect(fills).toHaveLength(0)
  })

  it('a listed agent logs in; another agent is still refused', async () => {
    const e = await create({ allowedAgents: ['geri'] })
    expect((await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('dani'))).status).toBe(403)
    const r = await call('POST', `/api/vault/web-logins/${e.id}/login`, ownToken('geri'))
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ outcome: 'success' })
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({ origin: 'https://shop.example.com', loginUrl: 'https://shop.example.com/', username: 'owner@example.com', password: SECRET })
  })

  it('a caller that names no agent is refused (the login happens in a named agent\'s browser)', async () => {
    const e = await create({ allowedAgents: ['geri'] })
    for (const auth of [TOKEN, SESSION]) {
      expect((await call('POST', `/api/vault/web-logins/${e.id}/login`, auth)).status).toBe(403)
    }
    expect(fills).toHaveLength(0)
  })
})

describe('writes are the owner\'s', () => {
  const ownerCookie = (): string => {
    const u = getDashboardUser('owner') ?? createDashboardUser('owner', 'x-not-a-real-hash')
    return `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
  }
  it.each([
    ['POST', '/api/vault/web-logins'],
    ['PUT', '/api/vault/web-logins/shop-example-com'],
    ['DELETE', '/api/vault/web-logins/shop-example-com'],
    ['POST', '/api/vault/web-logins/shop-example-com/unlock'],
  ])('%s %s: the access token and a sub-agent token get 403 before the body is read', async (method, path) => {
    const r = await call(method, path, TOKEN, '{not json')
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect((await call(method, path, ownToken('geri'), '{}', { cookie: ownerCookie() })).status).toBe(403)
  })
})

describe('the password never comes back', () => {
  it('not in the create answer, the list, the login answer, or any log line; the username is not logged either', async () => {
    const created = await call('POST', '/api/vault/web-logins', SESSION, { origin: 'https://shop.example.com', username: 'owner@example.com', password: SECRET, allowedAgents: ['geri'] })
    const id = created.json().login.id as string
    const list = await call('GET', '/api/vault/web-logins', TOKEN)
    const login = await call('POST', `/api/vault/web-logins/${id}/login`, claims('geri'))
    for (const t of [created.text, list.text, login.text]) expect(t).not.toContain(SECRET)
    expect(h.logs.join('\n')).not.toContain(SECRET)
    expect(h.logs.filter((l) => l.includes('vault-web-login')).join('\n')).not.toContain('owner@example.com')
    expect(h.vault.get(`web-login-${id}`)).toBe(SECRET)
  })
})

describe('attempt rules', () => {
  it('a wrong password locks the entry: no second try until the owner unlocks it', async () => {
    const e = await create({ allowedAgents: ['geri'] })
    nextOutcome = 'wrong'
    expect((await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))).json().outcome).toBe('wrong')
    nextOutcome = 'success'
    const again = await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))
    expect(again.status).toBe(423)
    expect(again.json().outcome).toBe('locked')
    expect(fills).toHaveLength(1)
    expect((await call('POST', `/api/vault/web-logins/${e.id}/unlock`, claims('geri'))).status).toBe(403)
    expect((await call('POST', `/api/vault/web-logins/${e.id}/unlock`, SESSION)).status).toBe(200)
    expect((await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))).json().outcome).toBe('success')
  })

  it('a new password lifts the lock', async () => {
    const e = await create({ allowedAgents: ['geri'] })
    nextOutcome = 'wrong'
    await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))
    expect((await call('PUT', `/api/vault/web-logins/${e.id}`, SESSION, { password: 'another-one' })).json().login.locked).toBe(false)
    expect(h.vault.get(`web-login-${e.id}`)).toBe('another-one')
  })

  it.each(['2fa', 'unknown', 'origin-mismatch', 'no-form'])('%s: a second try within 15 minutes is refused', async (o) => {
    const e = await create({ allowedAgents: ['geri'] })
    nextOutcome = o
    expect((await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))).json().outcome).toBe(o)
    const again = await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))
    expect(again.status).toBe(429)
    expect(fills).toHaveLength(1)
  })

  it('a browser that did not start is not the site\'s answer: no cool-down', async () => {
    const e = await create({ allowedAgents: ['geri'] })
    webLoginDeps.ensureBrowser = async () => null
    expect((await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))).json().outcome).toBe('browser-unavailable')
    webLoginDeps.ensureBrowser = async () => 'http://127.0.0.1:9400'
    expect((await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))).json().outcome).toBe('success')
  })
})

describe('the MCP output folder after a login', () => {
  it('what was written during the call is gone before the answer; an older file stays', async () => {
    const e = await create({ allowedAgents: ['geri'] })
    const old = join(outDir, 'page-old.yml')
    writeFileSync(old, 'old snapshot')
    const past = new Date(Date.now() - 10 * 60_000)
    utimesSync(old, past, past)
    const during = join(outDir, 'page-during.yml')
    duringFill = () => writeFileSync(during, `textbox "Password": ${SECRET}`)
    await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))
    expect(existsSync(during)).toBe(false)
    expect(existsSync(old)).toBe(true)
  })

  it('the folder is emptied of the call window even when the filler throws', async () => {
    const e = await create({ allowedAgents: ['geri'] })
    const during = join(outDir, 'page-during.yml')
    webLoginDeps.fill = async () => { writeFileSync(during, SECRET); throw new Error(`boom ${SECRET}`) }
    const r = await call('POST', `/api/vault/web-logins/${e.id}/login`, claims('geri'))
    expect(r.json()).toEqual({ outcome: 'unknown' })
    expect(existsSync(during)).toBe(false)
    expect(r.text + h.logs.join('\n')).not.toContain(SECRET)
  })
})

describe('validation', () => {
  it.each([
    [{ origin: 'https://shop.example.com/login' }, 'a path in the origin'],
    [{ origin: 'http://shop.example.com' }, 'plain http off loopback'],
    [{ origin: 'https://user:pw@shop.example.com' }, 'credentials in the origin'],
    [{ loginUrl: 'https://evil.example.net/login' }, 'a login page on another origin'],
    [{ allowedAgents: ['nobody'] }, 'an unknown agent'],
    [{ password: '' }, 'an empty password'],
  ] as Array<[Record<string, unknown>, string]>)('refuses %j (%s)', async (extra, _why) => {
    const r = await call('POST', '/api/vault/web-logins', SESSION, { origin: 'https://shop.example.com', username: 'u', password: 'p', ...extra })
    expect(r.status).toBe(400)
    expect(h.vault.size).toBe(0)
  })

  it('http on a loopback host is allowed (a local test page)', async () => {
    expect((await call('POST', '/api/vault/web-logins', SESSION, { origin: 'http://127.0.0.1:9341', username: 'u', password: 'p' })).status).toBe(201)
  })

  it('delete removes the password from the vault', async () => {
    const e = await create()
    expect((await call('DELETE', `/api/vault/web-logins/${e.id}`, SESSION)).status).toBe(200)
    expect(h.vault.has(`web-login-${e.id}`)).toBe(false)
  })
})

describe('the floor and the agent-token allowlist', () => {
  it('a web-login secret id is never agent-readable, whatever the case', () => {
    for (const id of ['web-login-shop-example-com', 'WEB-LOGIN-x', ' web-login-x']) {
      expect(isWebLoginSecretId(id)).toBe(true)
      expect(isAgentReadableDecodedVaultId(id)).toBe(false)
    }
    expect(isWebLoginSecretId('web-logins')).toBe(false)
  })

  it('a sub-agent token may list and log in, and nothing else here', () => {
    expect(isAgentAllowed('/api/vault/web-logins', 'GET', 'geri')).toBe(true)
    expect(isAgentAllowed('/api/vault/web-logins/shop-example-com/login', 'POST', 'geri')).toBe(true)
    expect(isAgentAllowed('/api/vault/web-logins', 'POST', 'geri')).toBe(false)
    expect(isAgentAllowed('/api/vault/web-logins/shop-example-com', 'PUT', 'geri')).toBe(false)
    expect(isAgentAllowed('/api/vault/web-logins/shop-example-com/unlock', 'POST', 'geri')).toBe(false)
    expect(isAgentAllowed('/api/vault/web-login-shop-example-com', 'GET', 'geri', () => ({ 'web-login-shop-example-com': ['geri'] }))).toBe(false)
  })
})
