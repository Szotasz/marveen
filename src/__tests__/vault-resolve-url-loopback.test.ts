// VAULTURLGATE1027: the resolver sends the dashboard token with every request, and VAULT_RESOLVE_URL comes
// from the environment. A URL off this machine is refused before any request is made, so the token never
// leaves it; 127.0.0.1, ::1 and localhost still work.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-resolve-url-loopback-'))
const TOKEN = 'loopback-test-token-0123456789'

type Mod = typeof import('../../scripts/vault-dashboard-client.mjs')
let mod: Mod
let calls: Array<{ url: string; auth: string | undefined }> = []
const savedUrl = process.env.VAULT_RESOLVE_URL
const savedTokenFile = process.env.VAULT_RESOLVE_TOKEN_FILE

beforeAll(async () => {
  mkdirSync(join(ROOT, 'store'), { recursive: true })
  writeFileSync(join(ROOT, 'store', '.dashboard-token'), TOKEN + '\n')
  mod = await import(join(process.cwd(), 'scripts', 'vault-dashboard-client.mjs'))
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  calls = []
  delete process.env.VAULT_RESOLVE_TOKEN_FILE
  vi.stubGlobal('fetch', async (url: string, init: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization })
    return new Response(JSON.stringify({ values: { A: 'x' }, missing: [], refused: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (savedUrl === undefined) delete process.env.VAULT_RESOLVE_URL
  else process.env.VAULT_RESOLVE_URL = savedUrl
  if (savedTokenFile === undefined) delete process.env.VAULT_RESOLVE_TOKEN_FILE
  else process.env.VAULT_RESOLVE_TOKEN_FILE = savedTokenFile
})

describe('VAULT_RESOLVE_URL reaches only this machine', () => {
  it('a URL off this machine is refused and no request carries the token', async () => {
    for (const url of [
      'https://evil.example/api/vault/resolve',
      'http://10.0.0.5:3420/api/vault/resolve',
      'http://127.0.0.2:3420/api/vault/resolve',
      'http://localhost.evil.example:3420/api/vault/resolve',
      'http://user:pw@127.0.0.1:3420/api/vault/resolve',
      'file:///etc/passwd',
      'not a url',
    ]) {
      process.env.VAULT_RESOLVE_URL = url
      const r = await mod.resolveViaDashboard(ROOT, ['A'])
      expect(r, url).toMatchObject({ ok: false, configured: true, error: 'VAULT_RESOLVE_URL is not a loopback address' })
    }
    expect(calls).toEqual([])
  })

  it('127.0.0.1, ::1 and localhost are asked, with the token', async () => {
    for (const url of ['http://127.0.0.1:3420/api/vault/resolve', 'http://[::1]:3420/api/vault/resolve', 'http://localhost:3420/api/vault/resolve']) {
      process.env.VAULT_RESOLVE_URL = url
      const r = await mod.resolveViaDashboard(ROOT, ['A'])
      expect(r, url).toMatchObject({ ok: true, values: { A: 'x' } })
    }
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:3420/api/vault/resolve', 'http://[::1]:3420/api/vault/resolve', 'http://localhost:3420/api/vault/resolve',
    ])
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('the default URL (no VAULT_RESOLVE_URL) is loopback', async () => {
    delete process.env.VAULT_RESOLVE_URL
    const r = await mod.resolveViaDashboard(ROOT, ['A'])
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).hostname).toBe('127.0.0.1')
  })

  it('the batched path is refused the same way', async () => {
    process.env.VAULT_RESOLVE_URL = 'https://evil.example/api/vault/resolve'
    const r = await mod.resolveInBatches(ROOT, Array.from({ length: 250 }, (_, i) => `ID${i}`), {})
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })
})
