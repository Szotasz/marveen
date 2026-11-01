// PATCH /api/vault/:id (#2396): rename a secret's label without touching its value.
// Black-box: drives the dashboard route handler against a real vault in a temp store.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-patch-label-'))
const STORE = join(ROOT, 'store')
mkdirSync(STORE, { recursive: true })
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: ROOT, STORE_DIR: STORE }))
// Never the real login Keychain: it is unavailable here, so the master key is a file key in the temp store.
const keychainCalls = vi.hoisted(() => ({ store: 0, retrieve: 0 }))
vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: () => false,
  keychainRetrieveStatus: () => { keychainCalls.retrieve++; return { status: 'empty', value: null } },
  keychainRetrieve: () => { keychainCalls.retrieve++; return null },
  keychainStore: () => { keychainCalls.store++ },
  keychainDelete: () => true,
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  PRETTY_OPTIONS: {},
}))

const savedEnvDir = process.env.CLAUDECLAW_ENV_DIR
process.env.CLAUDECLAW_ENV_DIR = STORE
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { listSecrets } = await import('../web/vault.js')

type Auth = RouteContext['auth']
const AUTH: Auth = { kind: 'token' }
const VALUE = 'SECRET-VALUE-patch-label-7f3a'

afterAll(() => {
  // Guard: the mocked keychain never stored a key, and the file key lives in the temp store.
  expect(keychainCalls.store).toBe(0)
  if (savedEnvDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedEnvDir
  rmSync(ROOT, { recursive: true, force: true })
})

function mkRes() {
  const r = {
    statusCode: 0, body: '', headers: {} as Record<string, string>,
    writeHead(c: number, h?: Record<string, string>) { r.statusCode = c; Object.assign(r.headers, h ?? {}) },
    end(b?: string) { r.body = b ?? '' },
    setHeader(k: string, v: string) { r.headers[k] = v },
    getHeader(k: string) { return r.headers[k] },
  }
  return r
}
// An unhandled request is a 404, like the dispatcher in web.ts.
async function call(method: string, path: string, rawBody?: string) {
  const res = mkRes()
  const req = (rawBody !== undefined ? Readable.from([Buffer.from(rawBody)]) : Readable.from([])) as unknown as http.IncomingMessage
  Object.assign(req, { headers: { 'content-type': 'application/json' }, method, url: path })
  const ctx: RouteContext = {
    req, res: res as unknown as http.ServerResponse,
    path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth: AUTH,
  }
  const handled = await tryHandleConnectors(ctx)
  if (!handled && res.statusCode === 0) res.statusCode = 404
  return res
}
const json = (r: { body: string }) => { try { return JSON.parse(r.body) } catch { return undefined } }
const patch = (id: string, body: unknown) => call('PATCH', `/api/vault/${id}`, typeof body === 'string' ? body : JSON.stringify(body))
const create = (id: string, label: string, value = VALUE) => call('POST', '/api/vault', JSON.stringify({ id, label, value }))
const list = async () => (json(await call('GET', '/api/vault')).secrets as Array<{ id: string; label: string; createdAt: string; updatedAt: string }>)
const entry = async (id: string) => (await list()).find(s => s.id === id)
const valueOf = async (id: string) => json(await call('GET', `/api/vault/${id}`))

let n = 0
let ID = ''
beforeEach(async () => {
  ID = `patch-label-${++n}`
  const res = await create(ID, 'Original label')
  expect(res.statusCode).toBe(200)
})

describe('PATCH /api/vault/:id renames the label of an existing secret', () => {
  it('answers 200 {ok:true}, lists the new label, keeps the value and createdAt', async () => {
    const before = (await entry(ID))!
    const res = await patch(ID, { label: 'Renamed label' })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ ok: true })
    const after = (await entry(ID))!
    expect(after.label).toBe('Renamed label')
    expect(after.createdAt).toBe(before.createdAt)
    expect(await valueOf(ID)).toEqual({ id: ID, value: VALUE })
  })

  it('ignores every other body field: a value in the body leaves the stored ciphertext byte-identical', async () => {
    // The entry for an id inside vault.json, whatever the container shape (map keyed by id, or list of {id,...}).
    const stored = (): Record<string, unknown> => {
      const walk = (node: unknown): Record<string, unknown> | undefined => {
        if (!node || typeof node !== 'object') return undefined
        const o = node as Record<string, unknown>
        if (o[ID] && typeof o[ID] === 'object') return o[ID] as Record<string, unknown>
        if (o.id === ID) return o
        for (const v of Object.values(o)) { const f = walk(v); if (f) return f }
        return undefined
      }
      const e = walk(JSON.parse(readFileSync(join(STORE, 'vault.json'), 'utf-8')))
      expect(e).toBeDefined()
      return e!
    }
    // Everything but the label and bookkeeping timestamps: the encrypted payload and its iv/tag/etc.
    const cipherPart = (e: Record<string, unknown>) => {
      const { label: _l, updatedAt: _u, id: _i, ...rest } = e
      return JSON.stringify(rest)
    }
    const before = cipherPart(stored())
    expect(before.length).toBeGreaterThan(2)

    const res = await patch(ID, { label: 'x', value: 'other-plaintext-should-be-ignored' })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ ok: true })
    expect((await entry(ID))!.label).toBe('x')
    expect(await valueOf(ID)).toEqual({ id: ID, value: VALUE })
    expect(cipherPart(stored())).toBe(before)
    expect(readFileSync(join(STORE, 'vault.json'), 'utf-8')).not.toContain('other-plaintext-should-be-ignored')
  })

  it('accepts a 50-character label', async () => {
    const label = 'a'.repeat(50)
    const res = await patch(ID, { label })
    expect(res.statusCode).toBe(200)
    expect((await entry(ID))!.label).toBe(label)
  })

  it.each([['empty', ''], ['whitespace', '   \t ']])('an %s label falls back to the id', async (_n, label) => {
    const res = await patch(ID, { label })
    expect(res.statusCode).toBe(200)
    expect((await entry(ID))!.label).toBe(ID)
    expect(await valueOf(ID)).toEqual({ id: ID, value: VALUE })
  })

  it('never puts the secret value in the response body', async () => {
    for (const body of [{ label: 'x' }, { label: '' }, { label: 5 }, {}, { label: 'y'.repeat(1000) }]) {
      const res = await patch(ID, body)
      expect(res.body).not.toContain(VALUE)
    }
    expect((await patch('does-not-exist-zz', { label: 'x' })).body).not.toContain(VALUE)
    expect((await patch(ID, 'not json{')).body).not.toContain(VALUE)
  })
})

describe('PATCH /api/vault/:id refuses what it cannot rename', () => {
  it('404 when the id does not exist, and creates nothing', async () => {
    const res = await patch('no-such-secret-zz', { label: 'x' })
    expect(res.statusCode).toBe(404)
    expect(await entry('no-such-secret-zz')).toBeUndefined()
  })

  it.each([
    ['missing', {}],
    ['a number', { label: 42 }],
    ['null', { label: null }],
    ['an object', { label: { a: 1 } }],
    ['an array', { label: ['x'] }],
  ])('400 when label is %s, label unchanged', async (_n, body) => {
    const res = await patch(ID, body)
    expect(res.statusCode).toBe(400)
    expect((await entry(ID))!.label).toBe('Original label')
  })

  it.each([['malformed JSON', 'not json{'], ['an empty body', ''], ['a JSON array', '[]'], ['a JSON string', '"x"']])('400 on %s, no crash', async (_n, raw) => {
    const res = await patch(ID, raw)
    expect(res.statusCode).toBe(400)
    expect((await entry(ID))!.label).toBe('Original label')
  })

  it('400 when the label is far over the length limit (1000 characters), label unchanged', async () => {
    const res = await patch(ID, { label: 'z'.repeat(1000) })
    expect(res.statusCode).toBe(400)
    expect((await entry(ID))!.label).toBe('Original label')
  })

  it('403 for an ssh-key- id, even when the secret exists', async () => {
    const sshId = 'ssh-key-patch-test'
    await create(sshId, 'ssh original')
    const res = await patch(sshId, { label: 'renamed' })
    expect(res.statusCode).toBe(403)
    // GET /api/vault hides ssh-key-* entries, so read the vault module's own listing.
    expect(listSecrets().find(s => s.id === sshId)?.label).toBe('ssh original')
  })

  it('403 for an ssh-key- id that does not exist (the prefix is checked, not the store)', async () => {
    const res = await patch('ssh-key-never-created', { label: 'x' })
    expect(res.statusCode).toBe(403)
  })
})

describe('PATCH on vault sub-resource names is not a secret rename', () => {
  it.each(['bindings', 'ssh-servers'])('/api/vault/%s creates nothing and does not answer {ok:true}', async (name) => {
    const before = (await list()).map(s => s.id).sort()
    const res = await patch(name, { label: 'hijack' })
    expect(json(res)).not.toEqual({ ok: true })
    expect(res.statusCode).not.toBe(200)
    expect((await list()).map(s => s.id).sort()).toEqual(before)
    expect(await entry(name)).toBeUndefined()
  })
})
