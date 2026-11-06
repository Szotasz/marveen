// An agent whose custom provider is deleted no longer starts ("Custom provider ... not found. Add it in Settings >
// Providers."), and nothing told the owner which agents a delete would stop. GET /api/custom-providers now gives each
// provider the agents whose agent-config.json names it (usedBy), so the delete question can name them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { tryHandleCustomProviders } = await import('../web/routes/custom-providers.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT } = await import('../config.js')
// custom-providers.ts keeps its file under PROJECT_ROOT/store (this checkout's, gitignored): saved and restored here,
// the same pattern as agent-write-owner-gated.test.ts.
const PROVIDERS_PATH = join(PROJECT_ROOT, 'store', 'custom-providers.json')
let providersBefore: string | null = null

const AGENTS = {
  '__test-cp-users-a': { customProvider: 'shared' },
  '__test-cp-users-b': { customProvider: 'shared' },
  '__test-cp-users-c': { customProvider: 'own' },
  '__test-cp-users-d': { model: 'claude-opus-5' },
} as const

async function get() {
  const req = Readable.from([]) as unknown as http.IncomingMessage
  req.headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const url = new URL('http://127.0.0.1:3420/api/custom-providers')
  expect(await tryHandleCustomProviders({ req, res, path: url.pathname, method: 'GET', url, auth: { kind: 'token' } } as any)).toBe(true)
  return { status: out.status || 200, body: out.body }
}

beforeAll(() => {
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  providersBefore = existsSync(PROVIDERS_PATH) ? readFileSync(PROVIDERS_PATH, 'utf-8') : null
  const def = (id: string) => ({ id, label: id, baseUrl: 'http://127.0.0.1:1', authHeader: 'none', vaultKey: null })
  writeFileSync(PROVIDERS_PATH, JSON.stringify({ providers: [def('shared'), def('own'), def('unused')] }, null, 2))
  for (const [name, config] of Object.entries(AGENTS)) {
    mkdirSync(agentDir(name), { recursive: true })
    writeFileSync(join(agentDir(name), 'agent-config.json'), JSON.stringify(config))
  }
})
afterAll(() => {
  for (const name of Object.keys(AGENTS)) rmSync(agentDir(name), { recursive: true, force: true })
  if (providersBefore !== null) writeFileSync(PROVIDERS_PATH, providersBefore)
  else rmSync(PROVIDERS_PATH, { force: true })
})

describe('GET /api/custom-providers names the agents that use each provider', () => {
  it('each provider carries usedBy: the agents whose agent-config names it, and only those', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    const byId = Object.fromEntries(r.body.providers.map((p: any) => [p.id, p]))
    expect(byId.shared.usedBy.filter((n: string) => n.startsWith('__test-cp-users-')).sort()).toEqual(['__test-cp-users-a', '__test-cp-users-b'])
    expect(byId.own.usedBy.filter((n: string) => n.startsWith('__test-cp-users-'))).toEqual(['__test-cp-users-c'])
  })

  it('a provider no agent uses has an empty list, not a missing field', async () => {
    const r = await get()
    const unused = r.body.providers.find((p: any) => p.id === 'unused')
    expect(unused.usedBy).toEqual([])
  })

  it('the definition fields are still all there', async () => {
    const r = await get()
    const shared = r.body.providers.find((p: any) => p.id === 'shared')
    expect(shared).toMatchObject({ id: 'shared', label: 'shared', baseUrl: 'http://127.0.0.1:1', authHeader: 'none', vaultKey: null })
  })
})
