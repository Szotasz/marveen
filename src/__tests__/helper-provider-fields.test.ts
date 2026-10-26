// Local helper routing (work/local-model-routing/SPEC.md 4.3): the optional
// helper fields on a custom provider survive POST /api/custom-providers (the
// route rebuilds the def field by field, so a new field is dropped unless it
// is copied explicitly), are validated, and -- the flag-off guarantee -- a
// payload without them is stored exactly as before.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const root = mkdtempSync(join(tmpdir(), 'helper-provider-fields-'))
mkdirSync(join(root, 'store'), { recursive: true })

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: root }))

let routes: typeof import('../web/routes/custom-providers.js')
let cp: typeof import('../web/custom-providers.js')

beforeAll(async () => {
  cp = await import('../web/custom-providers.js')
  routes = await import('../web/routes/custom-providers.js')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function call(method: string, path: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  expect(await routes.tryHandleCustomProviders({ req, res, path: url.pathname, method, url } as any)).toBe(true)
  return out
}

const storeText = () => readFileSync(join(root, 'store', 'custom-providers.json'), 'utf-8')

describe('custom provider helper fields', () => {
  it('a pre-helper payload is stored byte-identical to before (no helper keys added)', async () => {
    const r = await call('POST', '/api/custom-providers', { id: 'old', label: 'Old', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null })
    expect(r.status).toBe(200)
    // The exact bytes the route wrote before this change: five keys, in this order.
    const expected = JSON.stringify({ providers: [{ id: 'old', label: 'Old', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null }] }, null, 2)
    expect(storeText()).toBe(expected)
  })

  it('round-trips taskTypes, fallback, fallbackAgent and helperModel through POST and GET', async () => {
    const body = {
      id: 'solar', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null,
      helperModel: 'qwen3:14b',
      taskTypes: { watch: true, wake: true, quietHeartbeat: false, rotationDecision: true, triage: false, summary: false },
      fallback: { watch: 'skip', rotationDecision: 'opus' },
      fallbackAgent: 'marveen',
      junk: 'dropped',
    }
    expect((await call('POST', '/api/custom-providers', body)).status).toBe(200)
    const got = (await call('GET', '/api/custom-providers/solar')).body.provider
    expect(got.helperModel).toBe('qwen3:14b')
    expect(got.taskTypes).toEqual(body.taskTypes)
    expect(got.fallback).toEqual({ watch: 'skip', rotationDecision: 'opus' })
    expect(got.fallbackAgent).toBe('marveen')
    expect('junk' in got).toBe(false)
  })

  it.each([
    [{ taskTypes: { watching: true } }, /unknown task type/],
    [{ taskTypes: { watch: 'true' } }, /JSON boolean/],
    [{ fallback: { watch: 'maybe' } }, /skip.*opus/],
    [{ fallbackAgent: 'system' }, /system/],
    [{ helperModel: 'qwen3 14b; rm' }, /model tag/],
    [{ taskTypes: ['watch'] }, /object/],
  ])('rejects %j', async (extra, msg) => {
    const r = await call('POST', '/api/custom-providers', { id: 'bad', label: 'Bad', baseUrl: 'http://localhost:1', authHeader: 'none', vaultKey: null, ...extra })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(msg)
    expect(cp.loadCustomProvider('bad')).toBeNull()
  })
})

describe('helper defaults (SPEC.md section 2)', () => {
  it('a local provider without taskTypes ticks exactly the first four', () => {
    expect(cp.effectiveTaskTypes({ baseUrl: 'http://127.0.0.1:11434' })).toEqual({ watch: true, wake: true, quietHeartbeat: true, rotationDecision: true, triage: false, summary: false })
    expect(cp.effectiveTaskTypes({ baseUrl: 'http://localhost:11434' }).watch).toBe(true)
  })
  it('a remote provider defaults all-off, even one named like localhost', () => {
    expect(Object.values(cp.effectiveTaskTypes({ baseUrl: 'https://api.example.com' })).some(Boolean)).toBe(false)
    expect(Object.values(cp.effectiveTaskTypes({ baseUrl: 'https://localhost.evil.com' })).some(Boolean)).toBe(false)
  })
  it('stored ticks override the defaults', () => {
    expect(cp.effectiveTaskTypes({ baseUrl: 'http://127.0.0.1:1', taskTypes: { watch: false, summary: true } })).toMatchObject({ watch: false, summary: true, wake: true })
  })
  it('only rotationDecision falls back to opus by default', () => {
    const fb = cp.effectiveFallback({})
    expect(Object.entries(fb).filter(([, v]) => v === 'opus').map(([k]) => k)).toEqual(['rotationDecision'])
    expect(cp.effectiveFallback({ fallback: { watch: 'opus' } }).watch).toBe('opus')
  })
})
