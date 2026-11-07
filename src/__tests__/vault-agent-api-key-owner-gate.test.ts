// MAINAUTH1107 (Samu 72304/72307, Dani 72305): an agent's API key (agent-<name>-api-key, the main agent's included)
// decides which Console account that agent's prompts go to, so the generic vault routes write or delete one only for
// the owner (dashboard login), never for the shared access token a sub-agent holds. Other ids are unchanged.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const STORE = mkdtempSync(join(tmpdir(), 'vault-akey-gate-'))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, PRETTY_OPTIONS: {} }))

const setSecret = vi.fn()
const deleteSecret = vi.fn(() => true)
vi.mock('../web/vault.js', () => ({
  listSecrets: () => [],
  setSecret: (...a: unknown[]) => (setSecret as any)(...a),
  deleteSecret: (...a: unknown[]) => (deleteSecret as any)(...a),
  getSecret: () => null,
  getSecretsForEnv: () => ({}),
  updateSecretLabel: () => false,
  VAULT_LABEL_MAX_LENGTH: 200,
  normalizeVaultLabel: (id: string, label: string) => label.trim() || id,
}))
vi.mock('../web/vault-bindings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/vault-bindings.js')>()),
  syncSecret: () => ({ updated: 0, errors: [] }),
  removeBindingsForSecret: () => undefined,
}))
// The real gate (mayActAsOwner); only the refusal's body is simplified (no dashboard-user lookup in a unit test).
vi.mock('../web/routes/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/routes/auth.js')>()),
  refuseOwner: (res: http.ServerResponse, msg: string) => {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 'owner_session_required', error: msg }))
  },
}))

const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.CLAUDECLAW_ENV_DIR = STORE
const { tryHandleConnectors } = await import('../web/routes/connectors.js')

afterAll(() => {
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  rmSync(STORE, { recursive: true, force: true })
})
beforeEach(() => { setSecret.mockClear(); deleteSecret.mockClear() })

function mkRes() {
  const r = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    writeHead(c: number, hd?: Record<string, string>) { r.statusCode = c; Object.assign(r.headers, hd ?? {}) },
    end(b?: string) { r.body = b ?? '' },
    setHeader(k: string, v: string) { r.headers[k] = v },
    getHeader(k: string) { return r.headers[k] },
  }
  return r
}
type Auth = RouteContext['auth']
const TOKEN: Auth = { kind: 'token', agent: 'zz-agent' } as Auth
const SESSION: Auth = { kind: 'session' } as Auth
async function call(method: string, path: string, body: unknown, auth: Auth) {
  const res = mkRes()
  const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]) as unknown as http.IncomingMessage
  Object.assign(req, { headers: {}, method, url: path })
  const ctx: RouteContext = { req, res: res as unknown as http.ServerResponse, path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth }
  await tryHandleConnectors(ctx)
  return res
}

describe('generic vault routes: agent API keys are owner-only to write or delete', () => {
  it.each(['agent-marveen-api-key', 'agent-samu-api-key'])('POST %s with the shared token: 403, nothing stored', async (id) => {
    const r = await call('POST', '/api/vault', { id, label: 'x', value: 'fake-key' }, TOKEN)
    expect(r.statusCode).toBe(403)
    expect(JSON.parse(r.body).code).toBe('owner_session_required')
    expect(setSecret).not.toHaveBeenCalled()
  })
  it('POST with an owner session: stored', async () => {
    const r = await call('POST', '/api/vault', { id: 'agent-marveen-api-key', label: 'x', value: 'fake-key' }, SESSION)
    expect(r.statusCode).toBe(200)
    expect(setSecret).toHaveBeenCalledTimes(1)
  })
  it('POST of any other id with the shared token: unchanged (allowed)', async () => {
    const r = await call('POST', '/api/vault', { id: 'GOOGLE_API', label: 'x', value: 'v' }, TOKEN)
    expect(r.statusCode).toBe(200)
    expect(setSecret).toHaveBeenCalledTimes(1)
  })
  it('DELETE agent-<name>-api-key: token 403 and kept, owner deletes', async () => {
    const t = await call('DELETE', '/api/vault/agent-marveen-api-key', undefined, TOKEN)
    expect(t.statusCode).toBe(403)
    expect(deleteSecret).not.toHaveBeenCalled()
    const s = await call('DELETE', '/api/vault/agent-marveen-api-key', undefined, SESSION)
    expect(s.statusCode).toBe(200)
    expect(deleteSecret).toHaveBeenCalledTimes(1)
  })
  it('import into agent-<name>-api-key with the shared token: 403 before anything is read or stored', async () => {
    const r = await call('POST', '/api/vault/import', { imports: [{ serverName: 's', envVar: 'K', vaultId: 'agent-marveen-api-key', label: 'x', createBinding: false, targets: [] }] }, TOKEN)
    expect(r.statusCode).toBe(403)
    expect(setSecret).not.toHaveBeenCalled()
  })
})
