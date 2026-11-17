// VAULTSZELES826 PR-A: VAULT_ACL_AGENT_MODE, the observation week for a sub-agent's OWN token (AGENT_TOKENS).
// enforce (code default, today's behaviour): the token reads only what store/vault-acl.json lists for it.
// audit: every read passes and leaves a row with the allowlist's verdict, so the list can be proposed from measured
// rows. The SSH / sub-resource floor binds in both. A shared-token caller (X-Agent-Id claim) is not affected.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const STORE = mkdtempSync(join(tmpdir(), 'vault-agent-mode-test-'))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE }))

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))

const SECRET_VALUE = 'SECRET-VALUE-do-not-log-a91c'
vi.mock('../web/vault.js', () => ({
  listSecrets: () => [],
  setSecret: () => undefined,
  deleteSecret: () => false,
  getSecret: (id: string) => (['EXISTS', 'sshfoo', 'ssh-servers-x'].includes(id) ? SECRET_VALUE : null),
  getSecretsForEnv: () => ({}),
}))

const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.CLAUDECLAW_ENV_DIR = STORE
const { agentVaultMode, isAgentReadableDecodedVaultId } = await import('../web/vault-acl.js')
const { isAgentVaultReadAllowed, isAgentReadableVaultId } = await import('../web/auth-gate.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { setOverride, clearOverride } = await import('../settings-store.js')
const { getSettingDefinition } = await import('../config-registry.js')

type Auth = RouteContext['auth']
const OWN: Auth = { kind: 'token', agent: 'zz-agent', tokenAgent: 'zz-agent' }
const CLAIMED: Auth = { kind: 'token', agent: 'zz-agent' }
const ACL_FILE = join(STORE, 'vault-acl.json')
const saved = { agent: process.env.VAULT_ACL_AGENT_MODE, mode: process.env.VAULT_ACL_MODE }

beforeEach(() => {
  logSpy.info.mockClear()
  delete process.env.VAULT_ACL_AGENT_MODE
  delete process.env.VAULT_ACL_MODE
  clearOverride('VAULT_ACL_AGENT_MODE')
  clearOverride('VAULT_ACL_MODE')
  rmSync(ACL_FILE, { force: true })
  rmSync(join(STORE, '.env'), { force: true })
})
afterEach(() => {
  for (const [k, v] of [['VAULT_ACL_AGENT_MODE', saved.agent], ['VAULT_ACL_MODE', saved.mode]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
afterAll(() => {
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  rmSync(STORE, { recursive: true, force: true })
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
const resolve = (ids: string[], auth: Auth) => call('POST', '/api/vault/resolve', auth, JSON.stringify({ ids }))
const rows = () => logSpy.info.mock.calls.map(c => c[0]).filter(f => f?.event === 'vault-read')
const allow = (acl: object) => writeFileSync(ACL_FILE, JSON.stringify(acl), 'utf-8')

describe('the switch', () => {
  it('AM1 the code default is enforce, and only the exact value audit loosens', () => {
    expect(getSettingDefinition('VAULT_ACL_AGENT_MODE')?.default).toBe('enforce')
    expect(agentVaultMode()).toBe('enforce')
    for (const v of ['AUDIT', '1', 'off', '']) {
      setOverride('VAULT_ACL_AGENT_MODE', v)
      expect(agentVaultMode(), `override ${JSON.stringify(v)}`).toBe('enforce')
    }
    setOverride('VAULT_ACL_AGENT_MODE', 'audit')
    expect(agentVaultMode()).toBe('audit')
  })
  it('AM2 a .env line cannot loosen it (overrides-only); the owner override can', () => {
    writeFileSync(join(STORE, '.env'), 'VAULT_ACL_AGENT_MODE=audit\n')
    expect(agentVaultMode()).toBe('enforce')
    setOverride('VAULT_ACL_AGENT_MODE', 'audit')
    expect(agentVaultMode()).toBe('audit')
  })
  it('AM3 enforce in the process environment cannot be undone by an override', () => {
    process.env.VAULT_ACL_AGENT_MODE = 'enforce'
    setOverride('VAULT_ACL_AGENT_MODE', 'audit')
    expect(agentVaultMode()).toBe('enforce')
  })
  it('AM4 loosens is true exactly when moving to audit', () => {
    const loosens = getSettingDefinition('VAULT_ACL_AGENT_MODE')?.loosens
    expect(loosens).toBeTypeOf('function')
    expect(loosens!('enforce', 'audit')).toBe(true)
    expect(loosens!('enforce', ' audit ')).toBe(true)
    expect(loosens!('audit', 'enforce')).toBe(false)
    expect(loosens!('audit', 'audit')).toBe(false)
  })
})

describe('the route, enforce (default)', () => {
  it('AE1 an own token reads only what the ACL lists for it', async () => {
    expect((await get('EXISTS', OWN)).statusCode).toBe(403)
    const body = JSON.parse((await resolve(['EXISTS'], OWN)).body)
    expect(body.refused).toContainEqual({ id: 'EXISTS', reason: 'acl' })
    allow({ EXISTS: ['zz-agent'] })
    const ok = await get('EXISTS', OWN)
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body).value).toBe(SECRET_VALUE)
  })
  it('AE2 the floor holds even when the ACL lists an SSH id for the agent', async () => {
    allow({ sshfoo: ['zz-agent'], 'ssh-servers-x': ['zz-agent'] })
    expect((await get('sshfoo', OWN)).statusCode).toBe(403)
    const body = JSON.parse((await resolve(['ssh-servers-x'], OWN)).body)
    expect(body.refused).toContainEqual({ id: 'ssh-servers-x', reason: 'acl' })
    expect(Object.prototype.hasOwnProperty.call(body.values, 'ssh-servers-x')).toBe(false)
  })
})

describe('the route, audit (the observation week)', () => {
  beforeEach(() => { setOverride('VAULT_ACL_AGENT_MODE', 'audit') })
  it('AA1 an unlisted read passes and its row says what enforce would decide', async () => {
    const res = await get('EXISTS', OWN)
    expect(res.statusCode).toBe(200)
    const row = rows().at(-1)
    expect(row).toMatchObject({ id: 'EXISTS', kind: 'agent', principal: 'zz-agent', acl: 'no-acl', agent_mode: 'audit', refused: false })
    expect(JSON.stringify(logSpy.info.mock.calls)).not.toContain(SECRET_VALUE)
  })
  it('AA2 the batch resolve passes the same way', async () => {
    const body = JSON.parse((await resolve(['EXISTS'], OWN)).body)
    expect(body.values.EXISTS).toBe(SECRET_VALUE)
    expect(body.refused).toEqual([])
  })
  it('AA3 the floor still refuses SSH material and sub-resources', async () => {
    expect((await get('sshfoo', OWN)).statusCode).toBe(403)
    expect((await get('ssh-key-abc', OWN)).statusCode).toBe(403)
    const body = JSON.parse((await resolve(['ssh-servers-x', 'ssh-key-abc'], OWN)).body)
    expect(body.refused).toEqual([{ id: 'ssh-servers-x', reason: 'acl' }, { id: 'ssh-key-abc', reason: 'ssh-key' }])
    expect(Object.keys(body.values)).toEqual([])
  })
  it('AA4 a shared-token caller with an X-Agent-Id claim is not affected by the agent switch', async () => {
    process.env.VAULT_ACL_MODE = 'enforce'
    expect((await get('EXISTS', CLAIMED)).statusCode).toBe(403)
  })
})

describe('the auth gate (GET /api/vault/<raw id>)', () => {
  it('AG1 enforce: only listed ids; audit: the floor alone decides', () => {
    expect(isAgentVaultReadAllowed('zz-agent', 'EXISTS', {}, 'enforce')).toBe(false)
    expect(isAgentVaultReadAllowed('zz-agent', 'EXISTS', { EXISTS: ['zz-agent'] }, 'enforce')).toBe(true)
    expect(isAgentVaultReadAllowed('zz-agent', 'EXISTS', {}, 'audit')).toBe(true)
    for (const raw of ['ssh-key-abc', '%73sh-key-abc', 'SSH-servers', 'bindings', 'resolve', '%E0%A4%A', 'a%2Fb']) {
      expect(isAgentVaultReadAllowed('zz-agent', raw, { [decodeURIComponentSafe(raw)]: ['zz-agent'] }, 'audit'), raw).toBe(false)
      expect(isAgentVaultReadAllowed('zz-agent', raw, { [decodeURIComponentSafe(raw)]: ['zz-agent'] }, 'enforce'), raw).toBe(false)
    }
  })
  it('AG2 the default argument reads the switch', () => {
    expect(isAgentVaultReadAllowed('zz-agent', 'EXISTS', {})).toBe(false)
    setOverride('VAULT_ACL_AGENT_MODE', 'audit')
    expect(isAgentVaultReadAllowed('zz-agent', 'EXISTS', {})).toBe(true)
  })
  it('AG3 one floor: the raw and the decoded predicates agree', () => {
    for (const id of ['EXISTS', 'sshfoo', 'bindings', 'x/y', ' ', 'ok-id']) {
      expect(isAgentReadableVaultId(encodeURIComponent(id))).toBe(isAgentReadableDecodedVaultId(id))
    }
  })
})

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}
