// GMAILDRAFT1116 review B1, the NEGATIVE CONTROL: a reserved vault entry (the owner's gmail.compose grant behind
// POST /api/gmail/draft) is never revealed, resolved, bound, listed, written, relabelled or deleted through any vault
// route, for any principal: the shared token (with and without an X-Agent-Id claim), a sub-agent's own token (also
// with VAULT_ACL_AGENT_MODE=audit and an allowlist that names it), the owner session, a device key and a federation
// peer. The vault here is REAL (vault.ts with a file master key in a temp install; the Keychain is mocked away, the
// real one is never touched). After every round the entry is still there, unchanged, and no answer or log line holds
// its value. What this does NOT prove, by design: that an agent cannot decrypt store/vault.json itself (same OS user;
// see vault-reserved.ts). That limit is stated, not tested away.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return mkdtempSync(join(tmpdir(), 'vault-reserved-'))
})
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOT, STORE_DIR: `${ROOT}/store`, MAIN_AGENT_ID: 'marveen',
}))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => false,
  keychainRetrieveStatus: () => ({ status: 'unavailable', value: null }),
  keychainRetrieve: () => null,
  keychainStore: () => { throw new Error('keychain must not be touched in this test') },
  keychainDelete: () => false,
}))
const logSpy = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))
vi.mock('../notify.js', () => ({ notifySecurityEvent: vi.fn(async () => undefined), notifyOwner: vi.fn(), notifyChannel: vi.fn() }))
vi.mock('../db.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../db.js')>()), countDashboardUsers: () => 1 }))

mkdirSync(join(ROOT, 'store'), { recursive: true })
const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.CLAUDECLAW_ENV_DIR = ROOT
const vault = await import('../web/vault.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { tryHandleGmailDraft } = await import('../web/routes/gmail-draft.js')
const { tryHandleFleet } = await import('../web/routes/fleet.js')
const { isAgentReadableVaultId, isAgentVaultReadAllowed, agentScopeDenial } = await import('../web/auth-gate.js')
const { vaultReadRefused } = await import('../web/vault-acl.js')
const { validateCustomProvider } = await import('../web/custom-providers.js') as unknown as { validateCustomProvider?: (d: unknown) => string | null }
const { setOverride, clearOverride } = await import('../settings-store.js')
const { isReservedVaultId } = await import('../web/vault-reserved.js')

const REFRESH_VALUE = 'RESERVED-refresh-1//do-not-leak-7f3a'
const CLIENT_VALUE = '{"client_id":"cid-test","client_secret":"RESERVED-client-secret-9c1e"}'
const LEGACY_VALUE = 'RESERVED-legacy-refresh-2b8d'
const NORMAL_VALUE = 'normal-secret-value'
const VALUES = [REFRESH_VALUE, 'RESERVED-client-secret-9c1e', LEGACY_VALUE]
const RID = 'gmail-draft-compose-refresh'

beforeAll(() => {
  vault.reservedVaultAccess.write(RID, 'reserved refresh', REFRESH_VALUE)
  vault.reservedVaultAccess.write('gmail-draft-oauth-client', 'reserved client', CLIENT_VALUE)
  vault.reservedVaultAccess.write('GMAIL_DRAFT_COMPOSE_REFRESH', 'legacy', LEGACY_VALUE)
  vault.setSecret('NORMAL', 'normal', NORMAL_VALUE)
})
afterAll(() => {
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  rmSync(ROOT, { recursive: true, force: true })
})
beforeEach(() => {
  logSpy.info.mockClear(); logSpy.warn.mockClear()
  delete process.env.VAULT_ACL_MODE
  delete process.env.VAULT_ACL_AGENT_MODE
  clearOverride('VAULT_ACL_AGENT_MODE')
  rmSync(join(ROOT, 'store', 'vault-acl.json'), { force: true })
})

type Auth = RouteContext['auth']
const PRINCIPALS: Array<[string, Auth]> = [
  ['shared token', { kind: 'token' }],
  ['shared token claiming the main agent', { kind: 'token', agent: 'marveen' }],
  ['shared token claiming a sub-agent', { kind: 'token', agent: 'grafit' }],
  ['sub-agent own token', { kind: 'token', agent: 'grafit', tokenAgent: 'grafit' }],
  ['owner session', { kind: 'session', user: 'owner' }],
  ['device key (full)', { kind: 'device', device: 'phone', deviceId: 1, scope: 'full' }],
  ['federation peer', { kind: 'federation', peer: 'peer-a' }],
]
const SPELLINGS = [RID, 'GMAIL-DRAFT-COMPOSE-REFRESH', 'gmail_draft_compose_refresh', 'GMAIL_DRAFT_COMPOSE_REFRESH', 'gmail-draft-oauth-client']
const ENCODED = [...SPELLINGS.map(encodeURIComponent), '%67mail-draft-compose-refresh', '%20gmail-draft-compose-refresh', 'gmail%2Ddraft%2Dcompose%2Drefresh']

function mkRes() {
  const r = {
    statusCode: 200, body: '' as string | Buffer, headers: {} as Record<string, unknown>,
    writeHead(c: number, h?: Record<string, unknown>) { r.statusCode = c; Object.assign(r.headers, h ?? {}) },
    end(b?: string | Buffer) { r.body = b ?? '' },
    setHeader(k: string, v: unknown) { r.headers[k] = v },
    getHeader(k: string) { return r.headers[k] },
  }
  return r
}
async function call(handler: (c: RouteContext) => Promise<boolean>, method: string, path: string, auth: Auth, body?: unknown, headers: Record<string, string> = {}) {
  const res = mkRes()
  const raw = body === undefined ? undefined : JSON.stringify(body)
  const req = (raw !== undefined ? Readable.from([Buffer.from(raw)]) : Readable.from([])) as unknown as http.IncomingMessage
  const u = new URL(`http://127.0.0.1:3420${path}`)
  Object.assign(req, { headers, method, url: path })
  const ctx: RouteContext = { req, res: res as unknown as http.ServerResponse, path: u.pathname, method, url: u, auth }
  const handled = await handler(ctx)
  return { handled, status: res.statusCode, body: String(res.body) }
}

function expectIntact() {
  expect(vault.reservedVaultAccess.read(RID)).toBe(REFRESH_VALUE)
  expect(vault.reservedVaultAccess.read('gmail-draft-oauth-client')).toBe(CLIENT_VALUE)
  expect(vault.reservedVaultAccess.read('GMAIL_DRAFT_COMPOSE_REFRESH')).toBe(LEGACY_VALUE)
}
function expectNoValue(text: string, what: string) {
  for (const v of VALUES) expect(text, what).not.toContain(v)
}

describe('every vault route refuses the reserved entries, for every principal', () => {
  for (const [name, auth] of PRINCIPALS) {
    it(`R ${name}`, async () => {
      const seen: string[] = []
      const run = async (what: string, method: string, path: string, body?: unknown) => {
        const r = await call(tryHandleConnectors, method, path, auth, body)
        seen.push(`${what}: ${r.body}`)
        expectNoValue(r.body, `${name} ${what}`)
        return r
      }
      // the listing: names only, and the reserved ones are not even named
      const list = await run('list', 'GET', '/api/vault')
      expect(list.status).toBe(200)
      expect(JSON.parse(list.body).secrets.map((s: { id: string }) => s.id)).toEqual(['NORMAL'])
      // the value route, every spelling and encoding
      for (const id of ENCODED) {
        const r = await run(`value ${id}`, 'GET', `/api/vault/${id}`)
        expect(r.status, id).toBe(403)
      }
      // the resolver
      const res = await run('resolve', 'POST', '/api/vault/resolve', { ids: [...SPELLINGS, ` ${RID} `] })
      expect(res.status).toBe(200)
      const rj = JSON.parse(res.body)
      expect(rj.values).toEqual({})
      expect(rj.refused.map((x: { reason: string }) => x.reason)).toEqual(SPELLINGS.map(() => 'reserved').concat('reserved'))
      // generic writes: overwrite, relabel, delete, bind (env and header), import
      for (const id of SPELLINGS) {
        expect((await run(`write ${id}`, 'POST', '/api/vault', { id, label: 'x', value: 'attacker-grant' })).status, id).toBe(403)
        expect((await run(`label ${id}`, 'PATCH', `/api/vault/${encodeURIComponent(id)}`, { label: 'x' })).status, id).toBe(403)
        expect((await run(`delete ${id}`, 'DELETE', `/api/vault/${encodeURIComponent(id)}`)).status, id).toBe(403)
        const t = [{ mcpFilePath: join(ROOT, '.mcp.json'), serverName: 'x' }]
        expect((await run(`bind env ${id}`, 'POST', '/api/vault/bindings', { vaultSecretId: id, envVar: 'GMAIL_TOKEN', targets: t })).status, id).toBe(403)
        expect((await run(`bind header ${id}`, 'POST', '/api/vault/bindings', { vaultSecretId: id, headerName: 'Authorization', targets: t })).status, id).toBe(403)
        expect((await run(`import ${id}`, 'POST', '/api/vault/import', { imports: [{ serverName: 'x', envVar: 'Y', vaultId: id, label: 'l', createBinding: true, targets: t }] })).status, id).toBe(403)
      }
      // the read-only sub-resources answer, without the value
      await run('scan', 'GET', '/api/vault/scan')
      await run('sync', 'POST', '/api/vault/sync')
      await run('bindings', 'GET', '/api/vault/bindings')
      // the draft route's own status and credential routes
      const st = await call(tryHandleGmailDraft, 'GET', '/api/gmail/draft/status', auth)
      expectNoValue(st.body, `${name} gmail status`)
      const put = await call(tryHandleGmailDraft, 'PUT', '/api/gmail/draft/credentials', auth, { client: '{"client_id":"a","client_secret":"b"}', refreshToken: 'attacker-refresh-token' })
      expectNoValue(put.body, `${name} gmail credentials`)
      if (auth?.kind !== 'session') expect(put.status, name).toBe(403)
      else {
        // the owner may REPLACE it (that is the owner's route), and still gets no value back; restore for the next round
        expect(put.body).toBe(JSON.stringify({ ok: true, configured: true }))
        vault.reservedVaultAccess.write(RID, 'reserved refresh', REFRESH_VALUE)
        vault.reservedVaultAccess.write('gmail-draft-oauth-client', 'reserved client', CLIENT_VALUE)
      }
      expectIntact()
      expect(seen.length).toBeGreaterThan(40)
      // no log line carries a value either
      expectNoValue(JSON.stringify([...logSpy.info.mock.calls, ...logSpy.warn.mock.calls]), `${name} logs`)
    })
  }

  it('R the sub-agent token stays refused in VAULT_ACL_AGENT_MODE=audit and with an allowlist that names it', async () => {
    setOverride('VAULT_ACL_AGENT_MODE', 'audit')
    writeFileSync(join(ROOT, 'store', 'vault-acl.json'), JSON.stringify({ [RID]: ['grafit'], 'gmail-draft-oauth-client': ['grafit'] }))
    const sub: Auth = { kind: 'token', agent: 'grafit', tokenAgent: 'grafit' }
    const r = await call(tryHandleConnectors, 'GET', `/api/vault/${RID}`, sub)
    expect(r.status).toBe(403)
    expectNoValue(r.body, 'audit mode')
    // the gate floor: not even routed
    expect(isAgentReadableVaultId(RID)).toBe(false)
    expect(isAgentReadableVaultId('%67mail_draft_x')).toBe(false)
    expect(isAgentVaultReadAllowed('grafit', RID, { [RID]: ['grafit'] }, 'audit')).toBe(false)
    expect(agentScopeDenial(sub as never, `/api/vault/${RID}`, 'GET', 'marveen', () => ({ [RID]: ['grafit'] }))?.status).toBe(403)
    expect(vaultReadRefused(RID, sub, { [RID]: ['grafit'] }, 'audit', 'audit')).toBe(true)
    expect(isAgentReadableVaultId('NORMAL')).toBe(true)
  })

  it('R a fleet export with secrets stays owner-only (the plain export carries no vault at all)', async () => {
    for (const [name, auth] of PRINCIPALS.filter(([, a]) => a?.kind !== 'session')) {
      const r = await call(tryHandleFleet, 'GET', '/api/fleet/export', auth, undefined, { 'x-vault-password': 'a-long-enough-password-123' })
      expect(r.status, name).toBe(403)
      expectNoValue(r.body, name)
    }
  })
})

describe('in-process generic readers and writers refuse them too', () => {
  it('I getSecret / getSecretsForEnv / listSecrets / setSecret / deleteSecret / updateSecretLabel', () => {
    for (const id of SPELLINGS) {
      expect(vault.getSecret(id), id).toBeNull()
      expect(() => vault.setSecret(id, 'x', 'attacker'), id).toThrow(/reserved/)
      expect(vault.deleteSecret(id), id).toBe(false)
      expect(vault.updateSecretLabel(id, 'x'), id).toBe(false)
    }
    expect(vault.getSecretsForEnv({ GMAIL: RID, OTHER: 'NORMAL' })).toEqual({ OTHER: NORMAL_VALUE })
    expect(vault.listSecrets().map(s => s.id)).toEqual(['NORMAL'])
    expect(vault.getSecret('NORMAL')).toBe(NORMAL_VALUE)
    expectIntact()
  })
  it('I reservedVaultAccess is not a second generic reader: it refuses a normal id', () => {
    expect(() => vault.reservedVaultAccess.read('NORMAL')).toThrow()
    expect(() => vault.reservedVaultAccess.write('NORMAL', 'x', 'y')).toThrow()
    expect(() => vault.reservedVaultAccess.remove('NORMAL')).toThrow()
  })
  it('I a custom provider cannot name a reserved entry as its key', () => {
    if (!validateCustomProvider) return
    const err = validateCustomProvider({ id: 'p1', label: 'P', baseUrl: 'https://evil.example', authHeader: 'Bearer', vaultKey: RID, models: ['m'] })
    expect(String(err)).toMatch(/reserved/)
  })
  it('I the predicate', () => {
    for (const id of SPELLINGS) expect(isReservedVaultId(id)).toBe(true)
    for (const id of ['NORMAL', 'gmail-drafts', 'gmail', 'ssh-key-x', '', 'xgmail-draft-']) expect(isReservedVaultId(id)).toBe(false)
    expect(isReservedVaultId(undefined)).toBe(false)
  })
})

describe('source pin: who may hold reservedVaultAccess', () => {
  it('P only vault.ts (defines it) and gmail-draft.ts (the owner module) name it under src/', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')
    const hits: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') walk(p); continue }
        if (/\.(ts|mts|js|mjs)$/.test(n) && readFileSync(p, 'utf8').includes('reservedVaultAccess')) hits.push(relative(srcDir, p))
      }
    }
    walk(srcDir)
    expect(hits.sort()).toEqual(['web/gmail-draft.ts', 'web/vault.ts'])
  })
})
