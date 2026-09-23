// VAULTSZELES826 F0: every vault VALUE read leaves one audit row (id, kind,
// principal, allowlist verdict, found) and NEVER the value. Audit only: the
// allowlist verdict does not block anything in this phase.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))

const SECRET_VALUE = 'SECRET-VALUE-do-not-log-8f3a'
const SSH_KEY_ID = 'ssh-key-abc123'
// A marker, not a key-shaped string: the repo's secret-gate rightly refuses anything that looks like a real private key.
const SSH_PRIVATE = 'SSH-PRIVATE-MARKER-do-not-serve-7c1e'
const getSecretSpy = vi.fn((id: string) => (id === 'EXISTS' ? SECRET_VALUE : id === SSH_KEY_ID ? SSH_PRIVATE : null))
vi.mock('../web/vault.js', () => ({
  listSecrets: () => [{ id: SSH_KEY_ID, label: 'test key', createdAt: '', updatedAt: '' }],
  setSecret: () => undefined,
  deleteSecret: () => false,
  getSecret: (id: string) => getSecretSpy(id),
  getSecretsForEnv: () => ({}),
}))

const { readVaultAcl, principalOf, evaluateVaultRead, logVaultRead, isSshPrivateKeyId } = await import('../web/vault-acl.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')

const tmp = mkdtempSync(join(tmpdir(), 'vault-acl-test-'))
function aclFile(name: string, content: string): string {
  const p = join(tmp, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

function allLogPayloads(): string {
  return JSON.stringify([...logSpy.info.mock.calls, ...logSpy.warn.mock.calls, ...logSpy.error.mock.calls, ...logSpy.debug.mock.calls])
}

beforeEach(() => { logSpy.info.mockClear(); logSpy.warn.mockClear() })

describe('readVaultAcl', () => {
  it('missing file is an empty allowlist, no warning', () => {
    expect(readVaultAcl(join(tmp, 'nope.json'))).toEqual({})
    expect(logSpy.warn).not.toHaveBeenCalled()
  })
  it('malformed JSON is an empty allowlist plus a warning, never a throw', () => {
    expect(readVaultAcl(aclFile('bad.json', '{ not json'))).toEqual({})
    expect(logSpy.warn).toHaveBeenCalledTimes(1)
  })
  it('non-object top level is empty plus a warning', () => {
    expect(readVaultAcl(aclFile('arr.json', '["x"]'))).toEqual({})
    expect(logSpy.warn).toHaveBeenCalledTimes(1)
  })
  it('keeps string lists, trims names, drops non-list and non-string entries', () => {
    const acl = readVaultAcl(aclFile('ok.json', JSON.stringify({ A: [' samu ', 'dani', 7, ''], B: 'nope', C: [] })))
    expect(acl).toEqual({ A: ['samu', 'dani'], C: [] })
  })
})

describe('principalOf', () => {
  it('names the principal per kind and never a credential', () => {
    expect(principalOf(undefined)).toEqual({ kind: 'none', principal: 'none' })
    expect(principalOf({ kind: 'token' })).toEqual({ kind: 'token', principal: 'token' })
    expect(principalOf({ kind: 'session', user: 'szabi' })).toEqual({ kind: 'session', principal: 'szabi' })
    expect(principalOf({ kind: 'device', device: 'phone', deviceId: 3 })).toEqual({ kind: 'device', principal: 'phone' })
    expect(principalOf({ kind: 'federation', peer: 'peer-a' })).toEqual({ kind: 'federation', principal: 'peer-a' })
    // Forward-compatible with the F1 agent kind (not in the union yet).
    expect(principalOf({ kind: 'agent', agent: 'dani' } as unknown as RouteContext['auth'])).toEqual({ kind: 'agent', principal: 'dani' })
  })
})

describe('evaluateVaultRead', () => {
  const acl = { A: ['dani', 'samu'], B: [] as string[] }
  const agent = (name: string) => ({ kind: 'agent', agent: name } as unknown as RouteContext['auth'])
  it('owner lanes are never subject to the allowlist', () => {
    expect(evaluateVaultRead('A', { kind: 'token' }, acl)).toBe('owner-lane')
    expect(evaluateVaultRead('A', { kind: 'session', user: 'u' }, acl)).toBe('owner-lane')
    expect(evaluateVaultRead('A', { kind: 'device', device: 'd', deviceId: 1 }, acl)).toBe('owner-lane')
  })
  it('an agent is allowed only when listed; empty or missing entry is no-acl', () => {
    expect(evaluateVaultRead('A', agent('dani'), acl)).toBe('allowed')
    expect(evaluateVaultRead('A', agent('geri'), acl)).toBe('not-listed')
    expect(evaluateVaultRead('B', agent('dani'), acl)).toBe('no-acl')
    expect(evaluateVaultRead('Z', agent('dani'), acl)).toBe('no-acl')
  })
})

describe('logVaultRead', () => {
  it('emits one info row with id, kind, principal, verdict, mode and found', () => {
    logVaultRead('A', { kind: 'session', user: 'szabi' }, true, { A: ['dani'] })
    expect(logSpy.info).toHaveBeenCalledTimes(1)
    const [fields] = logSpy.info.mock.calls[0]
    expect(fields).toMatchObject({ event: 'vault-read', id: 'A', kind: 'session', principal: 'szabi', acl: 'owner-lane', mode: 'audit', found: true })
  })
})

// The route itself, driven through tryHandleConnectors with a mocked vault.
type MockRes = { statusCode: number; body: string; headers: Record<string, string>; writeHead: (c: number, h?: Record<string, string>) => void; end: (b?: string) => void; setHeader: (k: string, v: string) => void; getHeader: (k: string) => string | undefined }
function mkRes(): MockRes {
  const r: MockRes = {
    statusCode: 200, body: '', headers: {},
    writeHead(c, h) { r.statusCode = c; Object.assign(r.headers, h ?? {}) },
    end(b) { r.body = b ?? '' },
    setHeader(k, v) { r.headers[k] = v },
    getHeader(k) { return r.headers[k] },
  }
  return r
}
async function get(path: string, auth: RouteContext['auth']) {
  const res = mkRes()
  const ctx: RouteContext = {
    req: { headers: {}, method: 'GET', url: path } as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path, method: 'GET', url: new URL(`http://127.0.0.1:3420${path}`), auth,
  }
  const handled = await tryHandleConnectors(ctx)
  return { handled, res }
}

describe('GET /api/vault/:id audit row', () => {
  it('a found secret: value goes to the caller, the audit row carries id/kind/principal and NOT the value', async () => {
    const { handled, res } = await get('/api/vault/EXISTS', { kind: 'device', device: 'bridge-1', deviceId: 9 })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: 'EXISTS', value: SECRET_VALUE })
    const rows = logSpy.info.mock.calls.filter(c => c[0]?.event === 'vault-read')
    expect(rows).toHaveLength(1)
    expect(rows[0][0]).toMatchObject({ id: 'EXISTS', kind: 'device', principal: 'bridge-1', found: true, mode: 'audit' })
    expect(allLogPayloads()).not.toContain(SECRET_VALUE)
  })
  it('a missing secret still leaves a row (found:false) and a 404', async () => {
    const { res } = await get('/api/vault/MISSING', { kind: 'token' })
    expect(res.statusCode).toBe(404)
    const rows = logSpy.info.mock.calls.filter(c => c[0]?.event === 'vault-read')
    expect(rows).toHaveLength(1)
    expect(rows[0][0]).toMatchObject({ id: 'MISSING', kind: 'token', principal: 'token', found: false })
  })
  it('the row is written BEFORE the response is sent (a caller that dies mid-response is still audited)', async () => {
    let orderRowIndex = -1
    let orderEndIndex = -1
    let n = 0
    logSpy.info.mockImplementation((f: { event?: string }) => { if (f?.event === 'vault-read' && orderRowIndex < 0) orderRowIndex = n++ })
    const res = mkRes()
    const origEnd = res.end
    res.end = (b?: string) => { if (orderEndIndex < 0) orderEndIndex = n++; origEnd(b) }
    const ctx: RouteContext = {
      req: { headers: {}, method: 'GET', url: '/api/vault/EXISTS' } as unknown as http.IncomingMessage,
      res: res as unknown as http.ServerResponse,
      path: '/api/vault/EXISTS', method: 'GET', url: new URL('http://127.0.0.1:3420/api/vault/EXISTS'), auth: { kind: 'token' },
    }
    await tryHandleConnectors(ctx)
    logSpy.info.mockImplementation(() => undefined)
    expect(orderRowIndex).toBeGreaterThanOrEqual(0)
    expect(orderEndIndex).toBeGreaterThan(orderRowIndex)
  })
})

describe('GET /api/vault/ssh-key-<id>: SSH private keys are never served by the generic value route', () => {
  it('refuses with 403, returns no value, keeps the audit row, and never decrypts the key', async () => {
    getSecretSpy.mockClear()
    logSpy.info.mockClear()
    const { handled, res } = await get(`/api/vault/${SSH_KEY_ID}`, { kind: 'token' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).not.toHaveProperty('value')
    expect(res.body).not.toContain(SSH_PRIVATE)
    expect(getSecretSpy).not.toHaveBeenCalledWith(SSH_KEY_ID)
    const rows = logSpy.info.mock.calls.filter(c => c[0]?.event === 'vault-read')
    expect(rows).toHaveLength(1)
    expect(rows[0][0]).toMatchObject({ id: SSH_KEY_ID, kind: 'token', found: true })
  })
  it('a missing ssh-key id is refused the same way (found:false), not answered by the generic 404', async () => {
    logSpy.info.mockClear()
    const { res } = await get('/api/vault/ssh-key-nope', { kind: 'token' })
    expect(res.statusCode).toBe(403)
    const rows = logSpy.info.mock.calls.filter(c => c[0]?.event === 'vault-read')
    expect(rows[0][0]).toMatchObject({ id: 'ssh-key-nope', found: false })
  })
  it('positive control: an ordinary secret is still served', async () => {
    const { res } = await get('/api/vault/EXISTS', { kind: 'token' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: 'EXISTS', value: SECRET_VALUE })
  })
})

describe('isSshPrivateKeyId: one predicate for every writer', () => {
  it('matches the ssh-key- id prefix (trimmed), and nothing else', () => {
    expect(isSshPrivateKeyId('ssh-key-abc123')).toBe(true)
    expect(isSshPrivateKeyId('  ssh-key-abc123 ')).toBe(true)
    expect(isSshPrivateKeyId('ssh-keys')).toBe(false)
    expect(isSshPrivateKeyId('EXISTS')).toBe(false)
    expect(isSshPrivateKeyId('MARVEEN-CONNECTORS-PAT')).toBe(false)
  })
})

describe('POST /api/vault/bindings: an SSH private key cannot be bound', () => {
  // No serverName and no targets on purpose: without the guard the handler answers
  // 'No targets found' BEFORE any write, so even a mutant run touches no file.
  async function post(body: unknown) {
    const res = mkRes()
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
    ;(req as unknown as { headers: object; method: string }).headers = {}
    ;(req as unknown as { method: string }).method = 'POST'
    const ctx: RouteContext = {
      req, res: res as unknown as http.ServerResponse,
      path: '/api/vault/bindings', method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/vault/bindings'), auth: { kind: 'token' },
    }
    const handled = await tryHandleConnectors(ctx)
    return { handled, res }
  }
  it('a header binding to an ssh-key id is refused with the SSH reason, before target discovery', async () => {
    const { handled, res } = await post({ vaultSecretId: SSH_KEY_ID, headerName: 'Authorization', headerScheme: 'Bearer' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('SSH private keys cannot be bound to an env var or a header')
  })
  it('an env binding to an ssh-key id is refused the same way', async () => {
    const { res } = await post({ vaultSecretId: SSH_KEY_ID, envVar: 'DEPLOY_KEY' })
    expect(JSON.parse(res.body).error).toBe('SSH private keys cannot be bound to an env var or a header')
  })
  it('control: an ordinary id passes the guard and reaches the next check (no targets), not the SSH refusal', async () => {
    const { res } = await post({ vaultSecretId: 'EXISTS', headerName: 'Authorization' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('No targets found for this server')
  })
})
