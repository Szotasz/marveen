/**
 * PUT /api/agents/:name used a narrower, ad-hoc model-id regex for
 * custom-provider agents (`/^[a-zA-Z0-9._/:+-]+$/`) instead of the shared
 * MODEL_ID_RE (model-id.ts). MODEL_ID_RE deliberately allows `[` `]` for the
 * `[1m]` 1M-context suffix (the install's own default model shape); the
 * narrower regex did not, so a custom-provider agent could never be saved
 * with e.g. `oc/mimo[1m]` -- the write 400'd and the dashboard only showed a
 * generic save error. Fixed by routing the custom-provider branch through
 * isValidModelId() too, so there is one allowlist instead of two that drift.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tryHandleAgents } from '../web/routes/agents.js'
import { agentDir } from '../web/agent-config.js'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = '__test-custom-provider-model-id'
const DIR = agentDir(AGENT)
const PROVIDERS_PATH = join(STORE_DIR, 'custom-providers.json')
const PROVIDER_ID = '__test-provider'

let providersBefore: string | null = null

beforeAll(() => {
  mkdirSync(DIR, { recursive: true })
  mkdirSync(STORE_DIR, { recursive: true })
  providersBefore = existsSync(PROVIDERS_PATH) ? readFileSync(PROVIDERS_PATH, 'utf-8') : null
  const store = providersBefore ? JSON.parse(providersBefore) : { providers: [] }
  store.providers = [
    ...store.providers.filter((p: { id: string }) => p.id !== PROVIDER_ID),
    { id: PROVIDER_ID, label: 'Test provider', baseUrl: 'http://127.0.0.1:0', authHeader: 'none', vaultKey: null },
  ]
  writeFileSync(PROVIDERS_PATH, JSON.stringify(store, null, 2))
})

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
  if (providersBefore !== null) writeFileSync(PROVIDERS_PATH, providersBefore)
  else rmSync(PROVIDERS_PATH, { force: true })
})

async function putAgentModel(body: unknown): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(AGENT)}`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'PUT', url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

describe('PUT /api/agents/:name -- custom-provider model id uses the shared allowlist', () => {
  it('oc/mimo[1m] and oc/deepseek[1m] save for a custom-provider agent (the 1M suffix is not special-cased away)', async () => {
    for (const model of ['oc/mimo[1m]', 'oc/deepseek[1m]']) {
      const r = await putAgentModel({ customProvider: PROVIDER_ID, model })
      expect(r.status, model).toBe(200)
      expect(r.body?.ok, model).toBe(true)
      const config = JSON.parse(readFileSync(join(DIR, 'agent-config.json'), 'utf-8'))
      expect(config.model, model).toBe(model)
    }
  })

  it('still refuses a shell-metacharacter id for a custom-provider agent -- the invariant this check exists for', async () => {
    for (const model of ["oc/mimo'; rm -rf /", 'oc/evil;id', 'oc/$(whoami)', 'oc/a b']) {
      const r = await putAgentModel({ customProvider: PROVIDER_ID, model })
      expect(r.status, model).toBe(400)
      expect(String(r.body?.error), model).toMatch(/Érvénytelen modell-azonosító/)
    }
  })

  it('a non-custom-provider agent is unaffected: a plain claude id still saves', async () => {
    const r = await putAgentModel({ customProvider: null, model: 'claude-opus-5' })
    expect(r.status).toBe(200)
    expect(r.body?.ok).toBe(true)
    const config = JSON.parse(readFileSync(join(DIR, 'agent-config.json'), 'utf-8'))
    expect(config.model).toBe('claude-opus-5')
  })
})
