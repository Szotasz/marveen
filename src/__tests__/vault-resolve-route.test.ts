// D1 (1): VAULT_ACL_MODE and POST /api/vault/resolve. A trail and an access rule for honest callers
// (the X-Agent-Id claim is self-asserted), NOT isolation.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const STORE = mkdtempSync(join(tmpdir(), 'vault-resolve-test-'))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE }))

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))

const ID = 'EXISTS'
const SECRET_VALUE = 'SECRET-VALUE-do-not-log-5d2b'
vi.mock('../web/vault.js', () => ({
  listSecrets: () => [],
  setSecret: () => undefined,
  deleteSecret: () => false,
  getSecret: (id: string) => (id === 'EXISTS' || id === '__proto__' ? SECRET_VALUE : null),
  getSecretsForEnv: () => ({}),
}))

const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.CLAUDECLAW_ENV_DIR = STORE
const { vaultAclMode } = await import('../web/vault-acl.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { setOverride, clearOverride } = await import('../settings-store.js')

type Auth = RouteContext['auth']
const AGENT: Auth = { kind: 'token', agent: 'zz-agent' }
const ACL_FILE = join(STORE, 'vault-acl.json')
const savedMode = process.env.VAULT_ACL_MODE

beforeEach(() => {
  logSpy.info.mockClear()
  delete process.env.VAULT_ACL_MODE
  clearOverride('VAULT_ACL_MODE')
  rmSync(ACL_FILE, { force: true })
  rmSync(join(STORE, '.env'), { force: true })
})
afterAll(() => {
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
})
afterEach(() => {
  if (savedMode === undefined) delete process.env.VAULT_ACL_MODE
  else process.env.VAULT_ACL_MODE = savedMode
})

function mkRes() {
  const r = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    writeHead(c: number, h?: Record<string, string>) { r.statusCode = c; Object.assign(r.headers, h ?? {}) },
    end(b?: string) { r.body = b ?? '' },
    setHeader(k: string, v: string) { r.headers[k] = v },
    getHeader(k: string) { return r.headers[k] },
  }
  return r
}
async function call(method: string, path: string, auth: Auth, rawBody?: string) {
  const res = mkRes()
  const req = (rawBody !== undefined ? Readable.from([Buffer.from(rawBody)]) : Readable.from([])) as unknown as http.IncomingMessage
  Object.assign(req, { headers: {}, method, url: path })
  const ctx: RouteContext = {
    req, res: res as unknown as http.ServerResponse,
    path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth,
  }
  await tryHandleConnectors(ctx)
  return res
}
const get = (id: string, auth: Auth) => call('GET', `/api/vault/${id}`, auth)
const resolve = (body: unknown, auth: Auth) => call('POST', '/api/vault/resolve', auth, typeof body === 'string' ? body : JSON.stringify(body))
const readRows = () => logSpy.info.mock.calls.map(c => c[0]).filter(f => f?.event === 'vault-read')
const allow = (acl: object) => writeFileSync(ACL_FILE, JSON.stringify(acl), 'utf-8')

describe('GET /api/vault/:id with VAULT_ACL_MODE', () => {
  it('V1 audit (unset): a claiming agent with no allowlist entry still reads; the row says who claimed', async () => {
    const res = await get(ID, AGENT)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: ID, value: SECRET_VALUE })
    expect(readRows()[0]).toMatchObject({ mode: 'audit', claimed: 'zz-agent', channel: 'value', refused: false })
  })
  it('V2 enforce: refused with 403, no value, row says refused', async () => {
    process.env.VAULT_ACL_MODE = 'enforce'
    const res = await get(ID, AGENT)
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain(SECRET_VALUE)
    expect(readRows()[0]).toMatchObject({ mode: 'enforce', claimed: 'zz-agent', refused: true })
  })
  it('V3 enforce: an agent listed for the secret reads it', async () => {
    process.env.VAULT_ACL_MODE = 'enforce'
    allow({ [ID]: ['zz-agent'] })
    const res = await get(ID, AGENT)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).value).toBe(SECRET_VALUE)
  })
  it('V4 enforce: owner lanes (token without agent, session) are never refused', async () => {
    process.env.VAULT_ACL_MODE = 'enforce'
    expect((await get(ID, { kind: 'token' })).statusCode).toBe(200)
    expect((await get(ID, { kind: 'session', user: 'owner' })).statusCode).toBe(200)
  })
})

describe('POST /api/vault/resolve', () => {
  it('V5 audit: values, missing and the ssh-key refusal', async () => {
    const res = await resolve({ ids: [ID, 'nope', 'ssh-key-x'] }, AGENT)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      values: { [ID]: SECRET_VALUE }, missing: ['nope'], refused: [{ id: 'ssh-key-x', reason: 'ssh-key' }], mode: 'audit',
    })
    expect(readRows().every(r => r.channel === 'resolve')).toBe(true)
    expect(JSON.stringify(logSpy.info.mock.calls)).not.toContain(SECRET_VALUE)
  })
  it('V6 enforce: an unlisted claiming agent gets no values and an acl refusal', async () => {
    process.env.VAULT_ACL_MODE = 'enforce'
    const body = JSON.parse((await resolve({ ids: [ID] }, AGENT)).body)
    expect(body.values).toEqual({})
    expect(body.refused).toContainEqual({ id: ID, reason: 'acl' })
    expect(body.mode).toBe('enforce')
  })
  it('V10 audit: a secret whose id is __proto__ is an own property of values', async () => {
    const body = JSON.parse((await resolve({ ids: ['__proto__'] }, AGENT)).body)
    expect(Object.prototype.hasOwnProperty.call(body.values, '__proto__')).toBe(true)
    expect(body.values['__proto__']).toBe(SECRET_VALUE)
  })
  it('V11 enforce, claimed agent, empty allowlist: constructor is refused, no crash', async () => {
    process.env.VAULT_ACL_MODE = 'enforce'
    const res = await resolve({ ids: ['constructor'] }, AGENT)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).refused).toContainEqual({ id: 'constructor', reason: 'acl' })
  })
  it('V12 audit: the row for a claimed agent carries the allowlist verdict for that name', async () => {
    await resolve({ ids: [ID] }, AGENT)
    allow({ [ID]: ['other'] })
    await resolve({ ids: [ID] }, AGENT)
    allow({ [ID]: ['zz-agent'] })
    await resolve({ ids: [ID] }, AGENT)
    expect(readRows().map(r => r.acl)).toEqual(['no-acl', 'not-listed', 'allowed'])
  })
  it('V13 the GET ssh-key refusal logs refused true', async () => {
    const res = await get('ssh-key-x', { kind: 'token' })
    expect(res.statusCode).toBe(403)
    expect(readRows()[0]).toMatchObject({ id: 'ssh-key-x', refused: true, channel: 'value' })
  })
  it('V7 400 for malformed bodies', async () => {
    const bad: unknown[] = ['not json', {}, { ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => `id${i}`) }, { ids: ['x'.repeat(201)] }, { ids: [''] }]
    for (const b of bad) expect((await resolve(b, { kind: 'token' })).statusCode).toBe(400)
  })
  it('V8 GET /api/vault/resolve is not a secret read', async () => {
    const res = await get('resolve', { kind: 'token' })
    // not handled as a secret read: no value, no audit row (the mock res defaults to 200 when nothing answers)
    expect(res.body).not.toContain(SECRET_VALUE)
    expect(readRows()).toHaveLength(0)
  })
})

describe('vaultAclMode', () => {
  it('V9 only the exact value enforce (trimmed) enforces', () => {
    expect(vaultAclMode({ VAULT_ACL_MODE: 'enforce' })).toBe('enforce')
    expect(vaultAclMode({ VAULT_ACL_MODE: ' enforce ' })).toBe('enforce')
    for (const v of ['ENFORCE', '1', '', undefined]) expect(vaultAclMode({ VAULT_ACL_MODE: v })).toBe('audit')
    expect(vaultAclMode({})).toBe('audit')
  })
})

describe('VAULT_ACL_MODE registry entry', () => {
  it('V14 loosens is true only when leaving enforce (trimmed)', async () => {
    const { getSettingDefinition } = await import('../config-registry.js')
    const loosens = getSettingDefinition('VAULT_ACL_MODE')?.loosens
    expect(loosens).toBeTypeOf('function')
    expect(loosens!(' enforce', 'audit')).toBe(true)
    expect(loosens!('audit', 'enforce')).toBe(false)
  })
})

describe('the mode as the Settings page sets it', () => {
  it('M1 an override of enforce enforces without the process environment', async () => {
    setOverride('VAULT_ACL_MODE', 'enforce')
    expect(vaultAclMode()).toBe('enforce')
    expect((await get(ID, AGENT)).statusCode).toBe(403)
    const body = JSON.parse((await resolve({ ids: [ID] }, AGENT)).body)
    expect(body.refused).toContainEqual({ id: ID, reason: 'acl' })
    expect(Object.prototype.hasOwnProperty.call(body.values, ID)).toBe(false)
  })
  it('M2 the override wins over .env; without it the .env line counts', () => {
    setOverride('VAULT_ACL_MODE', 'audit')
    writeFileSync(join(STORE, '.env'), 'VAULT_ACL_MODE=enforce\n')
    expect(vaultAclMode()).toBe('audit')
    clearOverride('VAULT_ACL_MODE')
    expect(vaultAclMode()).toBe('enforce')
  })
  it('M3 enforce in the process environment cannot be undone by an override', () => {
    process.env.VAULT_ACL_MODE = 'enforce'
    setOverride('VAULT_ACL_MODE', 'audit')
    expect(vaultAclMode()).toBe('enforce')
  })
})
