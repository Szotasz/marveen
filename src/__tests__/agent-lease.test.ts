// AGENTLEASE1117: the temporary agent lease. The owner issues a time-boxed lease; while it is active the SHARED token
// (never a sub-agent's own token) may create a tmp- agent on a loopback custom provider under the lease-sandbox
// profile, up to maxAgents, and delete only those. Expiry or revoke deletes every agent created under it.
//
// The gate decisions run through the real routes (tryHandleAgents, tryHandleAgentLeases) on the real store file of
// this checkout; the provider registry, the owner notification, the CLI probe and the config log are stubbed, and
// countDashboardUsers answers 1 so the first-run setup (which would let the bare token create anything) is closed.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const H = vi.hoisted(() => ({ notified: [] as string[], configLog: [] as string[] }))

vi.mock('../web/custom-providers.js', async (orig) => ({
  ...await orig<typeof import('../web/custom-providers.js')>(),
  loadCustomProvider: (id: string) => ({
    local: { id: 'local', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null },
    lh: { id: 'lh', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', authHeader: 'none', vaultKey: null },
    cloud: { id: 'cloud', label: 'Cloud', baseUrl: 'https://api.example.com', authHeader: 'Bearer', vaultKey: 'k' },
    lan: { id: 'lan', label: 'LAN', baseUrl: 'https://192.168.1.20:11434', authHeader: 'none', vaultKey: null },
  } as Record<string, unknown>)[id] ?? null,
}))
vi.mock('../notify.js', async (orig) => ({
  ...await orig<typeof import('../notify.js')>(),
  notifyOwner: async (text: string) => { H.notified.push(text); return true },
}))
vi.mock('../db.js', async (orig) => ({
  ...await orig<typeof import('../db.js')>(),
  countDashboardUsers: () => 1,
  logConfigChange: (key: string, _o: unknown, n: unknown) => { H.configLog.push(`${key} ${String(n)}`) },
}))
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...await orig<typeof import('../web/claude-cli-version.js')>(),
  measureClaudeCliVersion: async () => ({ version: null, measuredAt: null, error: 'stubbed', source: 'test' }),
}))

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { tryHandleAgentLeases, sweepAgentLease } = await import('../web/routes/agent-leases.js')
const L = await import('../web/agent-lease.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT, STORE_DIR } = await import('../config.js')
import type { RouteContext } from '../web/routes/types.js'

const TOKEN = { kind: 'token' } as const
const SUB_TOKEN = { kind: 'token', agent: 'someagent', tokenAgent: 'someagent' } as const
const OWNER = { kind: 'session', user: 'owner' } as const
const NAMES = ['tmp-zzlease-a', 'tmp-zzlease-b', 'tmp-zzlease-c', 'tmp-zzlease-d', 'zzlease-plain']

async function call(method: string, path: string, auth: RouteContext['auth'], body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const out = { status: 200, body: {} as Record<string, unknown> }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() {},
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) as Record<string, unknown> },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = {}
  req.method = method
  req.url = path
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth } as unknown as RouteContext
  const handled = (await tryHandleAgentLeases(ctx)) || (await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web')))
  expect(handled).toBe(true)
  return out
}

const create = (name: string, auth: RouteContext['auth'] = TOKEN, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/agents', auth, { name, description: 'throwaway test', model: 'qwen3-8b', customProvider: 'local', ...extra })

function cleanup(): void {
  for (const n of NAMES) rmSync(agentDir(n), { recursive: true, force: true })
  rmSync(L.AGENT_LEASE_PATH, { force: true })
}

beforeEach(() => {
  mkdirSync(STORE_DIR, { recursive: true })
  cleanup()
  H.notified.length = 0
  H.configLog.length = 0
})
afterAll(cleanup)

describe('the pure decisions', () => {
  it('"local" is exactly a loopback host', () => {
    for (const u of ['http://localhost:11434', 'http://127.0.0.1:8080/v1', 'https://127.10.0.3', 'http://[::1]:11434']) {
      expect(L.isLoopbackBaseUrl(u), u).toBe(true)
    }
    for (const u of ['http://0.0.0.0:11434', 'http://192.168.1.20:11434', 'http://localhost.evil.com', 'http://foo.localhost',
      'https://api.example.com', 'http://127.0.0.1.nip.io', 'http://user:pw@localhost', 'ftp://localhost', 'not a url', 'http://127.0.0.300']) {
      expect(L.isLoopbackBaseUrl(u), u).toBe(false)
    }
  })

  it('the owner request is bounded: minutes 1..60 (default 60), maxAgents 1..3 (default 3)', () => {
    expect(L.parseLeaseRequest({})).toEqual({ ok: true, minutes: 60, maxAgents: 3, note: '' })
    expect(L.parseLeaseRequest({ minutes: 5, maxAgents: 1, note: ' x ' })).toEqual({ ok: true, minutes: 5, maxAgents: 1, note: 'x' })
    for (const bad of [{ minutes: 0 }, { minutes: 61 }, { minutes: 1.5 }, { maxAgents: 0 }, { maxAgents: 4 }, { note: 7 }]) {
      expect(L.parseLeaseRequest(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('only the shared token may use a lease', () => {
    expect(L.mayUseLeaseCredential(TOKEN)).toBe(true)
    expect(L.mayUseLeaseCredential(SUB_TOKEN)).toBe(false)
    expect(L.mayUseLeaseCredential(OWNER)).toBe(false)
    expect(L.mayUseLeaseCredential({ kind: 'device', device: 'd', deviceId: 1, scope: 'full' })).toBe(false)
    expect(L.mayUseLeaseCredential(undefined)).toBe(false)
  })
})

describe('the owner endpoints', () => {
  it('the shared token can neither issue, read nor revoke a lease', async () => {
    expect((await call('POST', '/api/agent-leases', TOKEN, { minutes: 5 })).status).toBe(403)
    expect((await call('GET', '/api/agent-leases', TOKEN)).status).toBe(403)
    expect((await call('DELETE', '/api/agent-leases/current', TOKEN)).status).toBe(403)
    expect(existsSync(L.AGENT_LEASE_PATH)).toBe(false)
  })

  it('the owner issues one lease, a second is refused while it is active, and the GET shows it', async () => {
    const r = await call('POST', '/api/agent-leases', OWNER, { minutes: 10, maxAgents: 2, note: 'local test' })
    expect(r.status).toBe(200)
    expect((r.body.lease as { maxAgents: number }).maxAgents).toBe(2)
    expect((await call('POST', '/api/agent-leases', OWNER, {})).status).toBe(409)
    expect((await call('POST', '/api/agent-leases', OWNER, { minutes: 90 })).status).toBe(400)
    const g = await call('GET', '/api/agent-leases', OWNER)
    expect(g.body.active).toBe(true)
    expect(H.configLog.some((l) => l.startsWith('agent_lease.create '))).toBe(true)
  })
})

describe('creating an agent with the shared token', () => {
  it('no lease: 403, nothing created', async () => {
    const r = await create('tmp-zzlease-a')
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect(existsSync(agentDir('tmp-zzlease-a'))).toBe(false)
  })

  it('active lease, tmp- name, loopback provider: created under lease-sandbox with an empty .mcp.json, the owner notified', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10, maxAgents: 2 })
    const r = await create('tmp-zzlease-a', TOKEN, { customProvider: 'lh' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const dir = agentDir('tmp-zzlease-a')
    expect(existsSync(dir)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'))).toEqual({ mcpServers: {} })
    const cfg = readFileSync(join(dir, 'agent-config.json'), 'utf-8')
    expect(cfg).toContain(L.LEASE_PROFILE_ID)
    expect(cfg).toContain('"lh"')
    expect(L.readAgentLease()!.agents.map((a) => a.name)).toEqual(['tmp-zzlease-a'])
    expect(H.notified.filter((t) => t.includes('tmp-zzlease-a'))).toHaveLength(1)
  })

  it('a sub-agent\'s own token cannot use an active lease', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    expect((await create('tmp-zzlease-a', SUB_TOKEN)).status).toBe(403)
    expect(existsSync(agentDir('tmp-zzlease-a'))).toBe(false)
  })

  it('a name without the tmp- prefix: 403', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    const r = await create('zzlease-plain')
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('lease_name')
    expect(existsSync(agentDir('zzlease-plain'))).toBe(false)
  })

  it('a non-local provider, a LAN provider or none at all: 403', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    for (const customProvider of ['cloud', 'lan', '']) {
      const r = await create('tmp-zzlease-a', TOKEN, { customProvider })
      expect(r.status, customProvider).toBe(403)
      expect(r.body.code).toBe('lease_provider')
    }
    expect(existsSync(agentDir('tmp-zzlease-a'))).toBe(false)
  })

  it('another security profile: 403', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    const r = await create('tmp-zzlease-a', TOKEN, { profile: 'developer-senior' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('lease_profile')
  })

  it('over maxAgents: 403, and a deleted agent does not free its slot', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10, maxAgents: 1 })
    expect((await create('tmp-zzlease-a')).status).toBe(200)
    const over = await create('tmp-zzlease-b')
    expect(over.status).toBe(403)
    expect(over.body.code).toBe('lease_limit')
    expect((await call('DELETE', '/api/agents/tmp-zzlease-a', TOKEN)).status).toBe(200)
    expect((await create('tmp-zzlease-b')).status).toBe(403)
  })

  it('an expired lease: 403, and the on-request check deletes its agents', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    expect((await create('tmp-zzlease-a')).status).toBe(200)
    const lease = L.readAgentLease()!
    lease.expiresAt = new Date(Date.now() - 1000).toISOString()
    L.writeAgentLease(lease)
    const r = await create('tmp-zzlease-b')
    expect(r.status).toBe(403)
    expect(existsSync(agentDir('tmp-zzlease-a'))).toBe(false)
    expect(existsSync(agentDir('tmp-zzlease-b'))).toBe(false)
    const ended = L.readAgentLease()!
    expect(ended.status).toBe('expired')
    expect(ended.agents[0]!.deletedBy).toBe('expired')
    expect(H.notified.filter((t) => t.includes('tmp-zzlease-a') && t.includes('lejárt'))).toHaveLength(1)
  })

  it('the minute sweep ends an overdue lease the same way', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    expect((await create('tmp-zzlease-a')).status).toBe(200)
    await sweepAgentLease(Date.now() + 11 * 60_000)
    expect(existsSync(agentDir('tmp-zzlease-a'))).toBe(false)
    expect(L.readAgentLease()!.status).toBe('expired')
  })
})

describe('deleting with the shared token', () => {
  it('only an agent created under the active lease', async () => {
    mkdirSync(agentDir('tmp-zzlease-d'), { recursive: true }) // a tmp- agent the lease did not create
    expect((await call('DELETE', '/api/agents/tmp-zzlease-d', TOKEN)).status).toBe(403) // no lease
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    const r = await call('DELETE', '/api/agents/tmp-zzlease-d', TOKEN)
    expect(r.status).toBe(403)
    expect(r.body.lease_code).toBe('lease_not_owned')
    expect(existsSync(agentDir('tmp-zzlease-d'))).toBe(true)
    expect((await create('tmp-zzlease-a')).status).toBe(200)
    expect((await call('DELETE', '/api/agents/tmp-zzlease-a', SUB_TOKEN)).status).toBe(403)
    expect((await call('DELETE', '/api/agents/tmp-zzlease-a', TOKEN)).status).toBe(200)
    expect(existsSync(agentDir('tmp-zzlease-a'))).toBe(false)
    expect(L.readAgentLease()!.agents[0]!.deletedBy).toBe('lease')
    expect(H.notified.filter((t) => t.includes('tmp-zzlease-a'))).toHaveLength(2) // created + deleted
  })
})

describe('revoke', () => {
  it('ends the lease, deletes its agents, and the token is refused after', async () => {
    await call('POST', '/api/agent-leases', OWNER, { minutes: 10 })
    expect((await create('tmp-zzlease-a')).status).toBe(200)
    expect((await create('tmp-zzlease-b')).status).toBe(200)
    const r = await call('DELETE', '/api/agent-leases/current', OWNER)
    expect(r.status).toBe(200)
    expect((r.body.lease as { status: string }).status).toBe('revoked')
    expect(existsSync(agentDir('tmp-zzlease-a'))).toBe(false)
    expect(existsSync(agentDir('tmp-zzlease-b'))).toBe(false)
    expect((await create('tmp-zzlease-c')).status).toBe(403)
    expect((await call('DELETE', '/api/agent-leases/current', OWNER)).status).toBe(404)
    expect(H.configLog.some((l) => l.startsWith('agent_lease.revoked '))).toBe(true)
  })
})

describe('source pins', () => {
  const ROUTE = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'agents.ts'), 'utf-8')
  it('the lease is consulted only after the owner gate refused, and only for the shared token', () => {
    expect(ROUTE).toContain("if (!mayActAsOwnerOrFirstRun(ctx.auth, req, 'agent-create')) {\n      if (mayUseLeaseCredential(ctx.auth)) {")
    expect(ROUTE).toContain('const asOwner = mayActAsOwner(ctx.auth, req)')
  })
  it('the lease agent profile is strict and allows nothing outside its own directory', async () => {
    const { loadProfileTemplate } = await import('../web/profiles.js')
    const p = loadProfileTemplate(L.LEASE_PROFILE_ID)
    expect(p.id).toBe(L.LEASE_PROFILE_ID)
    expect(p.permissionMode).toBe('strict')
    expect(p.filesystem.allow).toEqual(['Read(${AGENT_DIR}/**)', 'Edit(${AGENT_DIR}/**)'])
    expect(p.filesystem.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'Read(${PROJECT_ROOT}/store/**)', 'Bash(curl:*)']))
  })
})
