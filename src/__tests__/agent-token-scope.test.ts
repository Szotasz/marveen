// The sub-agent token scope: an ALLOWLIST of (method, path) pairs.
//
// Refusing only schedule writes left every other route open to a sub-agent
// token, and some of them undo the rule or mint an unrestricted principal from
// the scoped one (fleet import writes the schedule store; device keys, users
// and bridge enrollment accept kind 'token'). Each of those is driven here
// through the real route behind the real gate: 403 for the agent token, the
// handler still reached with the main token.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// HOME first: scheduled-tasks-io resolves SCHEDULED_TASKS_DIR on import.
const scratch = (() => {
  const root = mkdtempSync(join(tmpdir(), 'agent-token-scope-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.NODE_ENV = 'test'
  delete process.env.AGENT_DASHBOARD_TOKENS
  return { root, home }
})()

const { initDatabase } = await import('../db.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { gateRequest, AGENT_TOKEN_ALLOWLIST, isAgentReadableVaultId } = await import('../web/auth-gate.js')
const { ensureAgentToken, createAgentTokenResolver, agentTokenPath } = await import('../web/agent-tokens.js')
const { tryHandleSchedules } = await import('../web/routes/schedules.js')
const { tryHandleMessages } = await import('../web/routes/messages.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')
const { tryHandleAuth } = await import('../web/routes/auth.js')
const { tryHandleSecurity } = await import('../web/routes/security.js')
const { tryHandleFleet } = await import('../web/routes/fleet.js')
const { tryHandleAgentTerminal } = await import('../web/routes/agent-terminal.js')
const { SCHEDULED_TASKS_DIR } = await import('../web/scheduled-tasks-io.js')

const MAIN_TOKEN = 'f'.repeat(64)
const AGENT = 'agent-a'

function mkReq(headers: Record<string, string | undefined> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { rmSync(scratch.root, { recursive: true, force: true }) })

function provision(base: string): { token: string; resolver: (t: string) => string | null } {
  mkdirSync(join(base, AGENT), { recursive: true })
  ensureAgentToken(AGENT, base, MAIN_TOKEN)
  return {
    token: readFileSync(agentTokenPath(AGENT, base), 'utf-8'),
    resolver: createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN }),
  }
}

describe('HTTP: credential laundering and store writes are closed for an agent token', () => {
  let server: http.Server
  let origin = ''
  let agentTok = ''

  beforeAll(async () => {
    const p = provision(join(scratch.root, 'http-agents'))
    agentTok = p.token
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method || 'GET'
      const auth = gateRequest(req, res, url, path, method, { dashboardToken: MAIN_TOKEN, resolveAgentToken: p.resolver, mainAgentId: MAIN_AGENT_ID })
      if (auth === null) return
      const ctx = {
        req, res, path, method, url, fedPeer: null,
        auth: auth.kind === 'token' ? (auth.agent ? { kind: 'token' as const, agent: auth.agent } : { kind: 'token' as const }) : undefined,
      }
      try {
        // same relative order as web.ts
        if (await tryHandleAuth(ctx)) return
        if (await tryHandleSecurity(ctx)) return
        if (await tryHandleMessages(ctx)) return
        if (await tryHandleKanban(ctx)) return
        if (await tryHandleSchedules(ctx)) return
        if (await tryHandleAgentTerminal(ctx)) return
        if (await tryHandleFleet(ctx)) return
        res.writeHead(404); res.end('Not found')
      } catch (err) {
        res.writeHead(500); res.end(String(err))
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  async function call(method: string, path: string, token: string | null, body?: unknown) {
    const headers: Record<string, string> = {}
    if (token !== null) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const r = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    let json: Record<string, unknown> = {}
    try { json = JSON.parse(text) } catch { /* non-JSON */ }
    return { status: r.status, json }
  }

  it('setup: a schedule exists that an import could overwrite', async () => {
    expect(SCHEDULED_TASKS_DIR.startsWith(scratch.home)).toBe(true)
    const c = await call('POST', '/api/schedules', MAIN_TOKEN, { name: 'existing-task', description: 'd', prompt: 'p', schedule: '0 8 * * *', agent: MAIN_AGENT_ID, type: 'task' })
    expect(c.status).toBe(200)
  })

  // Each must be 403 'agent-token-scope' for a sub-agent token AND still reach
  // its handler with the main token (the main-token calls use bodies that stop
  // at the handler's own validation, or write only the in-memory DB).
  const closed: Array<{ what: string; method: string; path: string; agentBody: unknown; mainBody: unknown; mainStatus: number }> = [
    { what: 'fleet import writes the schedule store', method: 'POST', path: '/api/fleet/import?apply=true',
      agentBody: { schemaVersion: 1, agents: [], scheduledTasks: [{ dirName: 'existing-task', skillMd: 'x', config: {} }] },
      mainBody: {}, mainStatus: 400 },
    { what: 'device-key minting', method: 'POST', path: '/api/auth/device-keys', agentBody: { name: 'agent-minted-key' }, mainBody: { name: 'main-key' }, mainStatus: 201 },
    { what: 'dashboard user creation', method: 'POST', path: '/api/auth/users',
      agentBody: { username: 'agent-user', password: 'Long-password-2026' }, mainBody: { username: 'main-user', password: 'Long-password-2026' }, mainStatus: 201 },
    { what: 'bridge enrollment (mints a key)', method: 'POST', path: '/api/security/bridge-enroll', agentBody: { key_line: 'ssh-ed25519 AAAA x', name: 'agent-bridge' }, mainBody: {}, mainStatus: 400 },
    { what: 'terminal-input toggle', method: 'POST', path: '/api/terminal-input', agentBody: { enabled: true }, mainBody: {}, mainStatus: 400 },
  ]

  for (const b of closed) {
    it(`closed: ${b.what} (${b.method} ${b.path}) -> 403 for the agent token, handler reached for the main token`, async () => {
      const a = await call(b.method, b.path, agentTok, b.agentBody)
      expect(a.status).toBe(403)
      expect(a.json.rule).toBe('agent-token-scope')
      expect(a.json.agent).toBe(AGENT)
      expect(a.json.main_agent).toBe(MAIN_AGENT_ID)
      expect(String(a.json.error)).toContain('via /api/messages')
      const m = await call(b.method, b.path, MAIN_TOKEN, b.mainBody)
      expect(m.status, JSON.stringify(m.json)).toBe(b.mainStatus)
    })
  }

  it('the refused agent calls minted nothing: only the main-token device key and user exist', async () => {
    const keys = await call('GET', '/api/auth/device-keys', MAIN_TOKEN)
    expect(keys.status).toBe(200)
    const names = (keys.json.keys as Array<{ name: string }>).map((k) => k.name)
    expect(names).toContain('main-key')
    expect(names).not.toContain('agent-minted-key')
    const users = await call('GET', '/api/auth/users', MAIN_TOKEN)
    const unames = (users.json.users as Array<{ username: string }>).map((u) => u.username)
    expect(unames).toContain('main-user')
    expect(unames).not.toContain('agent-user')
    expect(existsSync(join(SCHEDULED_TASKS_DIR, 'existing-task', 'task-config.json'))).toBe(true)
    expect(readFileSync(join(SCHEDULED_TASKS_DIR, 'existing-task', 'SKILL.md'), 'utf-8')).not.toBe('x')
    // and an agent token cannot even LIST them
    expect((await call('GET', '/api/auth/device-keys', agentTok)).status).toBe(403)
  })

  it('public probes stay public for an agent token (the scope applies to gated paths only)', async () => {
    expect((await call('GET', '/api/auth/status', agentTok)).status).toBe(200)
  })

  it('the agent API itself still works over HTTP: messages, kanban, schedule reads', async () => {
    expect((await call('GET', '/api/schedules', agentTok)).status).toBe(200)
    expect((await call('POST', '/api/messages', agentTok, { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'scope test' })).status).toBe(200)
    const k = await call('POST', '/api/kanban', agentTok, { title: 'scope test card' })
    expect(k.status).toBe(200)
    expect((await call('GET', '/api/kanban', agentTok)).status).toBe(200)
  })
})

// ---- The allowlist at gate level ---------------------------------------------

// Drive gateRequest with a minimal res double: the gate either writes 401/403
// or returns the principal (the route would then run).
function gateStatus(method: string, path: string, token: string, resolver: (t: string) => string | null): { status: number; body: Record<string, unknown> } {
  const out = { status: 0, body: {} as Record<string, unknown> }
  const res = {
    writeHead(code: number) { out.status = code; return res },
    end(data?: unknown) { try { out.body = JSON.parse(String(data ?? '{}')) } catch { /* non-JSON */ } },
    setHeader() { return res },
  } as unknown as http.ServerResponse
  const url = new URL(`http://127.0.0.1${path}`)
  const auth = gateRequest(mkReq({ authorization: `Bearer ${token}` }), res, url, url.pathname, method, {
    dashboardToken: MAIN_TOKEN, resolveAgentToken: resolver, mainAgentId: MAIN_AGENT_ID,
  })
  if (auth !== null) out.status = 200 // passed the gate; the route decides from here
  return out
}

// One concrete request per allowlist entry. The coverage test fails if an entry
// is added without a sample, so this list cannot silently rot.
const ALLOWLIST_SAMPLES: Array<[string, string]> = [
  ['GET', '/api/schedules'], ['GET', '/api/schedules/summary'], ['HEAD', '/api/schedules'],
  ['POST', '/api/messages'], ['GET', '/api/messages'], ['GET', '/api/messages/42'], ['GET', '/api/messages/threads'], ['PUT', '/api/messages/42'],
  ['GET', '/api/kanban'], ['GET', '/api/kanban/abc123'], ['GET', '/api/kanban/abc123/comments'], ['GET', '/api/kanban/labels'],
  ['GET', '/api/kanban-projects'], ['POST', '/api/kanban'], ['PUT', '/api/kanban/abc123'],
  ['POST', '/api/kanban/abc123/claim'], ['POST', '/api/kanban/abc123/release'], ['POST', '/api/kanban/abc123/move'],
  ['POST', '/api/kanban/abc123/comments'], ['POST', '/api/kanban/abc123/archive'], ['POST', '/api/kanban/abc123/unarchive'],
  ['POST', '/api/kanban/abc123/labels'], ['POST', '/api/kanban/abc123/blockers'],
  ['GET', '/api/memories'], ['GET', '/api/memories/42'], ['GET', '/api/memories/42/versions'], ['POST', '/api/memories'], ['PATCH', '/api/memories/42'], ['PUT', '/api/memories/42'],
  ['GET', '/api/daily-log'], ['GET', '/api/daily-log/dates'], ['POST', '/api/daily-log'],
  ['GET', '/api/approvals'], ['GET', '/api/approvals/abc-123'], ['POST', '/api/approvals'],
  ['GET', '/api/agents'],
  ['GET', '/api/vault'], ['GET', '/api/vault/example-api-key'],
  ['POST', `/api/agent-taskstate/${AGENT}`], ['GET', `/api/agent-taskstate/${AGENT}`], ['GET', `/api/agent-taskstate/${AGENT}/replay`], ['POST', `/api/agent-taskstate/${AGENT}/consume`],
  ['POST', '/api/skill-usage'], ['POST', '/api/tool-log'], ['GET', '/api/voice/directive'],
]

// Every dashboard call the generated sub-agent instructions teach: the
// CLAUDE.md written by agent-scaffold.ts (memory, daily log, approvals,
// messages, message close, system-directive check, X-Agent-Id, memory search,
// schedules read), the kanban dispatch instructions (routes/kanban.ts) and the
// PreCompact prompt in templates/settings.json.template.
const TAUGHT_CALLS: Array<[string, string]> = [
  ['POST', '/api/memories'], ['GET', '/api/memories'], ['GET', '/api/memories/42'], ['GET', '/api/memories/42/versions'],
  ['PUT', '/api/memories/42'], ['PATCH', '/api/memories/42'],
  ['POST', '/api/daily-log'],
  ['POST', '/api/approvals'], ['GET', '/api/approvals/abc-123'],
  ['POST', '/api/messages'], ['GET', '/api/messages/42'], ['PUT', '/api/messages/42'],
  ['GET', '/api/schedules'],
  ['GET', '/api/kanban'], ['GET', '/api/kanban/abc123'], ['PUT', '/api/kanban/abc123'], ['POST', '/api/kanban/abc123/move'],
  ['POST', '/api/kanban/abc123/comments'], ['GET', '/api/kanban/labels'], ['GET', '/api/kanban/assignees'],
  ['GET', '/api/kanban/archived'], ['GET', '/api/kanban/stuck'], ['GET', '/api/kanban/heartbeat-summary'], ['GET', '/api/kanban-projects'],
  ['POST', `/api/agent-taskstate/${AGENT}`],
]

// MEASURED: every dashboard call the five sub-agents of one live install issued
// in 7 days (a replay of their transcripts; method inferred per call site).
// 918 calls, 28 method+path pairs; ':id' stands for any concrete id. Two calls
// whose URL suffix was built at runtime were resolved by reading the call site
// (one /move, one /comments) and folded in.
const MEASURED_SUBAGENT_CALLS: Array<{ method: string; path: string; count: number }> = [
  { method: 'GET', path: '/api/agents', count: 3 },
  { method: 'GET', path: '/api/approvals', count: 2 },
  { method: 'POST', path: '/api/approvals', count: 1 },
  { method: 'GET', path: '/api/approvals/:id', count: 4 },
  { method: 'PATCH', path: '/api/approvals/:id', count: 1 },
  { method: 'GET', path: '/api/daily-log', count: 1 },
  { method: 'POST', path: '/api/daily-log', count: 26 },
  { method: 'GET', path: '/api/kanban', count: 97 },
  { method: 'POST', path: '/api/kanban', count: 40 },
  { method: 'GET', path: '/api/kanban/:id', count: 15 },
  { method: 'PUT', path: '/api/kanban/:id', count: 18 },
  { method: 'POST', path: '/api/kanban/:id/archive', count: 1 },
  { method: 'POST', path: '/api/kanban/:id/claim', count: 20 },
  { method: 'GET', path: '/api/kanban/:id/comments', count: 35 },
  { method: 'POST', path: '/api/kanban/:id/comments', count: 220 },
  { method: 'POST', path: '/api/kanban/:id/move', count: 72 },
  { method: 'POST', path: '/api/kanban/:id/release', count: 4 },
  { method: 'GET', path: '/api/memories', count: 24 },
  { method: 'POST', path: '/api/memories', count: 61 },
  { method: 'GET', path: '/api/memories/:id', count: 3 },
  { method: 'PATCH', path: '/api/memories/:id', count: 12 },
  { method: 'GET', path: '/api/messages', count: 36 },
  { method: 'POST', path: '/api/messages', count: 11 },
  { method: 'GET', path: '/api/messages/:id', count: 113 },
  { method: 'GET', path: '/api/schedules', count: 4 },
  { method: 'POST', path: '/api/schedules', count: 7 },
  { method: 'GET', path: '/api/vault', count: 1 },
  { method: 'GET', path: '/api/vault/:id', count: 86 },
]

describe('allowlist coverage, the taught calls and the measured replay', () => {
  let agentTok = ''
  let resolver: (t: string) => string | null = () => null
  beforeAll(() => {
    const p = provision(join(scratch.root, 'allow-agents'))
    agentTok = p.token
    resolver = p.resolver
  })

  it('every allowlist entry has a sample, and every sample passes the gate for an agent token', () => {
    for (const e of AGENT_TOKEN_ALLOWLIST) {
      const covered = ALLOWLIST_SAMPLES.some(([m, p]) => (e.methods.includes(m) || (m === 'HEAD' && e.methods.includes('GET'))) && e.pattern.test(p))
      expect(covered, `no sample for ${e.methods.join('|')} ${e.pattern}`).toBe(true)
    }
    for (const [m, p] of ALLOWLIST_SAMPLES) {
      const r = gateStatus(m, p, agentTok, resolver)
      expect(r.status, `${m} ${p} -> ${JSON.stringify(r.body)}`).toBe(200)
    }
  })

  it('every call the generated sub-agent instructions teach passes the gate', () => {
    for (const [m, p] of TAUGHT_CALLS) {
      expect(gateStatus(m, p, agentTok, resolver).status, `${m} ${p}`).toBe(200)
    }
  })

  it('replay: of the measured sub-agent calls only the named ones become 403, each under its rule', () => {
    const denied: string[] = []
    let deniedCalls = 0
    for (const c of MEASURED_SUBAGENT_CALLS) {
      const concrete = c.path === '/api/vault/:id' ? '/api/vault/example-api-key' : c.path.replace(':id', '42')
      const r = gateStatus(c.method, concrete, agentTok, resolver)
      if (r.status === 403) { denied.push(`${c.method} ${c.path} [${String(r.body.rule)}] x${c.count}`); deniedCalls += c.count } else expect(r.status, `${c.method} ${c.path}`).toBe(200)
    }
    expect(denied).toEqual([
      // resolving an approval is the main agent's / owner's lane (1 call: an agent withdrew its own request)
      'PATCH /api/approvals/:id [agent-token-scope] x1',
      // the schedule rule
      'POST /api/schedules [schedule-writes-main-agent-only] x7',
    ])
    expect(deniedCalls).toBe(8)
    expect(MEASURED_SUBAGENT_CALLS.length).toBe(28)
    expect(MEASURED_SUBAGENT_CALLS.reduce((n, c) => n + c.count, 0)).toBe(918)
  })

  it('outside the allowlist is 403 agent-token-scope; the main token passes the same requests', () => {
    const outside: Array<[string, string]> = [
      ['POST', '/api/fleet/import'], ['GET', '/api/fleet/export'], ['POST', '/api/auth/device-keys'], ['POST', '/api/auth/users'],
      ['POST', '/api/security/bridge-enroll'], ['POST', '/api/terminal-input'], ['POST', `/api/agents/${MAIN_AGENT_ID}/keys`],
      ['POST', '/api/agents/agent-b/restart'], ['PUT', '/api/settings'], ['DELETE', '/api/memories/42'], ['POST', '/api/memories/import'],
      ['POST', '/api/vault'], ['POST', '/api/vault/bindings'], ['DELETE', '/api/kanban/abc123'], ['PATCH', '/api/approvals/abc'],
      ['POST', '/api/approvals/abc/consume'], ['POST', '/api/messages/42'], ['DELETE', '/api/messages/42'], ['POST', '/api/kanban/labels'],
      ['GET', '/api/agents/agent-b/pane/stream'], ['GET', '/.well-known/fleetq'], ['GET', '/api/network-info'],
      ['POST', '/api/tool-log/prune'], ['POST', '/api/voice/modality/set'],
      // vault: no sub-resources and no SSH material, decoded spellings included
      ['GET', '/api/vault/bindings'], ['GET', '/api/vault/scan'], ['GET', '/api/vault/ssh-keys'], ['GET', '/api/vault/ssh-servers'],
      ['GET', '/api/vault/ssh-key-abc123'], ['GET', '/api/vault/%73sh-key-abc123'], ['GET', '/api/vault/SSH-KEY-abc'], ['GET', '/api/vault/%62indings'],
      ['GET', '/api/vault/ssh-keys/abc'], ['GET', '/api/vault/ssh-servers/1'],
    ]
    for (const [m, p] of outside) {
      const r = gateStatus(m, p, agentTok, resolver)
      expect(r.status, `${m} ${p}`).toBe(403)
      expect(r.body.rule).toBe('agent-token-scope')
      expect(r.body.main_agent).toBe(MAIN_AGENT_ID)
      expect(gateStatus(m, p, MAIN_TOKEN, resolver).status, `main ${m} ${p}`).toBe(200)
    }
  })

  it('isAgentReadableVaultId judges the decoded id', () => {
    expect(isAgentReadableVaultId('example-api-key')).toBe(true)
    expect(isAgentReadableVaultId('%73sh-key-x')).toBe(false)
    expect(isAgentReadableVaultId('a%2Fb')).toBe(false)
    expect(isAgentReadableVaultId('%E0%A4%A')).toBe(false) // undecodable
  })
})
