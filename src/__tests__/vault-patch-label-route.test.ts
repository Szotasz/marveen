// PATCH /api/vault/:id: label-only update route.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const STORE = mkdtempSync(join(tmpdir(), 'vault-patch-test-'))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), STORE_DIR: STORE }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, PRETTY_OPTIONS: {} }))

const SECRET_VALUE = 'SECRET-VALUE-do-not-leak-91c4'
const h = vi.hoisted(() => ({ labels: new Map<string, string>() }))
const updateSecretLabel = vi.fn((id: string, label: string) => {
  if (!h.labels.has(id)) return false
  h.labels.set(id, label)
  return true
})
const getSecret = vi.fn(() => SECRET_VALUE)
const setSecret = vi.fn()
const syncSecret = vi.fn(() => ({ updated: 0, errors: [] }))
vi.mock('../web/vault.js', () => ({
  listSecrets: () => [...h.labels].map(([id, label]) => ({ id, label, createdAt: '', updatedAt: '' })),
  setSecret: (...a: unknown[]) => (setSecret as any)(...a),
  deleteSecret: () => false,
  getSecret: (...a: unknown[]) => (getSecret as any)(...a),
  getSecretsForEnv: () => ({}),
  updateSecretLabel: (...a: unknown[]) => (updateSecretLabel as any)(...a),
  // same rule as the real module (src/web/vault.ts)
  VAULT_LABEL_MAX_LENGTH: 200,
  normalizeVaultLabel: (id: string, label: string) => label.trim() || id,
}))
vi.mock('../web/vault-bindings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/vault-bindings.js')>()),
  syncSecret: (...a: unknown[]) => (syncSecret as any)(...a),
}))

const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.CLAUDECLAW_ENV_DIR = STORE
const { tryHandleConnectors } = await import('../web/routes/connectors.js')

afterAll(() => {
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  rmSync(STORE, { recursive: true, force: true })
})
beforeEach(() => {
  h.labels.clear()
  h.labels.set('K1', 'old')
  updateSecretLabel.mockClear()
  getSecret.mockClear()
  syncSecret.mockClear()
  setSecret.mockClear()
})

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
async function call(method: string, path: string, rawBody: string) {
  const res = mkRes()
  const req = Readable.from([Buffer.from(rawBody)]) as unknown as http.IncomingMessage
  Object.assign(req, { headers: {}, method, url: path })
  const ctx: RouteContext = {
    req, res: res as unknown as http.ServerResponse,
    path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth: { kind: 'token', agent: 'zz-agent' },
  }
  await tryHandleConnectors(ctx)
  return res
}

const patch = (id: string, rawBody: string) => call('PATCH', `/api/vault/${id}`, rawBody)
const post = (body: unknown) => call('POST', '/api/vault', JSON.stringify(body))

describe('POST /api/vault label rule (shared with PATCH)', () => {
  it('400 above 200 characters, nothing stored', async () => {
    const res = await post({ id: 'K1', label: 'a'.repeat(201), value: 'v' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('label must be at most 200 characters')
    expect(setSecret).not.toHaveBeenCalled()
  })

  it('an existing secret with a 300-char stored label can rotate its value with that same label', async () => {
    const long = 'x'.repeat(300)
    h.labels.set('LONG', long)
    expect((await post({ id: 'LONG', label: long, value: 'new' })).statusCode).toBe(200)
    expect(setSecret).toHaveBeenCalledWith('LONG', long, 'new')
  })

  it('the same secret with a different 300-char label is rejected', async () => {
    h.labels.set('LONG', 'x'.repeat(300))
    expect((await post({ id: 'LONG', label: 'y'.repeat(300), value: 'new' })).statusCode).toBe(400)
    expect(setSecret).not.toHaveBeenCalled()
  })

  it('a new id with a 300-char label is rejected', async () => {
    expect((await post({ id: 'FRESH', label: 'x'.repeat(300), value: 'v' })).statusCode).toBe(400)
    expect(setSecret).not.toHaveBeenCalled()
  })

  it('accepts exactly 200 characters, so PATCH can edit it later', async () => {
    const label = 'a'.repeat(200)
    expect((await post({ id: 'K1', label, value: 'v' })).statusCode).toBe(200)
    expect(setSecret).toHaveBeenCalledWith('K1', label, 'v')
  })

  it('a missing label falls back to the id', async () => {
    expect((await post({ id: 'K1', value: 'v' })).statusCode).toBe(200)
    expect(setSecret).toHaveBeenCalledWith('K1', 'K1', 'v')
  })

  it('a whitespace label falls back to the id', async () => {
    expect((await post({ id: 'K1', label: '   ', value: 'v' })).statusCode).toBe(200)
    expect(setSecret).toHaveBeenCalledWith('K1', 'K1', 'v')
  })

  it('400 when label is not a string', async () => {
    expect((await post({ id: 'K1', label: 5, value: 'v' })).statusCode).toBe(400)
    expect(setSecret).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/vault/:id', () => {
  it('200 updates only the label; never reads or syncs the value', async () => {
    const res = await patch('K1', JSON.stringify({ label: '  new label ' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(updateSecretLabel).toHaveBeenCalledWith('K1', 'new label')
    expect(getSecret).not.toHaveBeenCalled()
    expect(syncSecret).not.toHaveBeenCalled()
    expect(res.body).not.toContain(SECRET_VALUE)
  })

  it('404 for an unknown id', async () => {
    expect((await patch('NOPE', JSON.stringify({ label: 'x' }))).statusCode).toBe(404)
  })

  it('400 when label is not a string', async () => {
    for (const body of [{ label: 5 }, { label: null }, {}, [], null]) {
      expect((await patch('K1', JSON.stringify(body))).statusCode).toBe(400)
    }
    expect(updateSecretLabel).not.toHaveBeenCalled()
  })

  it('400 on invalid JSON without throwing', async () => {
    expect((await patch('K1', '{not json')).statusCode).toBe(400)
    expect(updateSecretLabel).not.toHaveBeenCalled()
  })

  it('400 above 200 characters, 200 at exactly 200', async () => {
    expect((await patch('K1', JSON.stringify({ label: 'a'.repeat(201) }))).statusCode).toBe(400)
    expect((await patch('K1', JSON.stringify({ label: 'a'.repeat(200) }))).statusCode).toBe(200)
  })

  it('403 for ssh-key-* ids, nothing written', async () => {
    expect((await patch('ssh-key-abc', JSON.stringify({ label: 'x' }))).statusCode).toBe(403)
    expect(updateSecretLabel).not.toHaveBeenCalled()
  })

  it('an empty or blank label falls back to the id', async () => {
    await patch('K1', JSON.stringify({ label: '' }))
    expect(updateSecretLabel).toHaveBeenLastCalledWith('K1', 'K1')
    await patch('K1', JSON.stringify({ label: '   ' }))
    expect(updateSecretLabel).toHaveBeenLastCalledWith('K1', 'K1')
  })

  it('sub-resource names are not captured as secret ids', async () => {
    for (const name of ['bindings', 'sync', 'scan', 'import', 'ssh-servers', 'ssh-keys', 'resolve']) {
      updateSecretLabel.mockClear()
      await patch(name, JSON.stringify({ label: 'x' }))
      expect(updateSecretLabel).not.toHaveBeenCalled()
    }
  })
})
