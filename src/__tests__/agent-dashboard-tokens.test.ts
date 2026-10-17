// Per-agent dashboard tokens and the server-side schedule-write refusal.
//
// Policy: a sub-agent does not create, modify or delete schedules (the rule
// scripts/self-pace-gate.mjs applies to its shell commands). The hook reads the
// command line, so a python urllib or node fetch POST passes it; the server is
// where every client lands, so the server now refuses it for a sub-agent token.
//
// The HTTP half drives the exact gate web.ts runs (gateRequest) in front of the
// real route handlers, over a real socket, with HOME pointed at a scratch dir
// so the schedule writes never touch the operator's ~/.claude/scheduled-tasks.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// HOME must be redirected BEFORE any module computes homedir() at load time
// (scheduled-tasks-io resolves SCHEDULED_TASKS_DIR once, on import), hence the
// dynamic imports below: only node builtins are imported statically.
const scratch = (() => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tokens-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.NODE_ENV = 'test'
  delete process.env.AGENT_DASHBOARD_TOKENS
  return { root, home }
})()

const { initDatabase } = await import('../db.js')
const { MAIN_AGENT_ID } = await import('../config.js')
const { logger } = await import('../logger.js')
const {
  resolveAuth, gateRequest, isScheduleWrite, agentScopeDenial,
} = await import('../web/auth-gate.js')
const {
  ensureAgentToken, createAgentTokenResolver, dashboardTokenPathFor, matchAgentToken,
  migrateAgentClaudeMdTokenRefs, loadAgentTokens, agentTokenPath, mainTokenPath,
  agentTokensEnabled, invalidateAgentTokenCache,
} = await import('../web/agent-tokens.js')
const { tryHandleSchedules } = await import('../web/routes/schedules.js')
const { tryHandleMessages } = await import('../web/routes/messages.js')
const { tryHandleKanban } = await import('../web/routes/kanban.js')
const { SCHEDULED_TASKS_DIR } = await import('../web/scheduled-tasks-io.js')

const MAIN_TOKEN = 'f'.repeat(64)
const AGENT = 'agent-a'
const SCHEDULE_DENIED = `only the main agent writes schedules; send the request to ${MAIN_AGENT_ID} via /api/messages`

function mkReq(headers: Record<string, string | undefined> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { rmSync(scratch.root, { recursive: true, force: true }) })

function mode(p: string): number {
  return lstatSync(p).mode & 0o777
}

// The rollback switch, flipped for one test and always restored.
function setSwitch(value: string | undefined): void {
  if (value === undefined) delete process.env.AGENT_DASHBOARD_TOKENS
  else process.env.AGENT_DASHBOARD_TOKENS = value
  invalidateAgentTokenCache()
}
afterEach(() => setSwitch(undefined))

describe('isScheduleWrite / agentScopeDenial (pure policy)', () => {
  it('treats every non-GET method on /api/schedules and below as a write', () => {
    expect(isScheduleWrite('/api/schedules', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x', 'PUT')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x', 'PATCH')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x', 'DELETE')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x/toggle', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/schedules/x/run', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/schedules/pending/3', 'DELETE')).toBe(true)
    // spelling variants are caught too (the router would 404 them anyway)
    expect(isScheduleWrite('/API/Schedules', 'post')).toBe(true)
    expect(isScheduleWrite('//api//schedules', 'POST')).toBe(true)
    expect(isScheduleWrite('/api/%73chedules', 'POST')).toBe(true)
  })
  it('leaves reads and unrelated paths alone', () => {
    expect(isScheduleWrite('/api/schedules', 'GET')).toBe(false)
    expect(isScheduleWrite('/api/schedules/summary', 'GET')).toBe(false)
    expect(isScheduleWrite('/api/schedules', 'HEAD')).toBe(false)
    expect(isScheduleWrite('/api/schedulesx', 'POST')).toBe(false)
    expect(isScheduleWrite('/api/messages', 'POST')).toBe(false)
    expect(isScheduleWrite('/api/kanban', 'POST')).toBe(false)
  })
  it('restricts ONLY a sub-agent token principal; a self-asserted claim restricts nothing', () => {
    expect(agentScopeDenial({ kind: 'token' }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    expect(agentScopeDenial({ kind: 'token', claimedAgent: AGENT }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    expect(agentScopeDenial({ kind: 'session', user: 'op' }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    expect(agentScopeDenial({ kind: 'device', device: 'd', deviceId: 1, scope: 'full' }, '/api/schedules', 'POST', MAIN_AGENT_ID)).toBeNull()
    const d = agentScopeDenial({ kind: 'token', agent: AGENT }, '/api/schedules', 'POST', MAIN_AGENT_ID)
    expect(d?.status).toBe(403)
    expect(d?.body).toEqual({ error: SCHEDULE_DENIED, rule: 'schedule-writes-main-agent-only', agent: AGENT, main_agent: MAIN_AGENT_ID })
    expect(agentScopeDenial({ kind: 'token', agent: AGENT }, '/api/schedules', 'GET', MAIN_AGENT_ID)).toBeNull()
  })
})

describe('token provisioning (ensureAgentToken)', () => {
  const base = join(scratch.root, 'prov-agents')
  beforeAll(() => { mkdirSync(join(base, AGENT), { recursive: true }) })

  it('creates the token file with mode 0600', () => {
    const r = ensureAgentToken(AGENT, base, MAIN_TOKEN)
    expect(r?.created).toBe(true)
    const p = agentTokenPath(AGENT, base)
    expect(mode(p)).toBe(0o600)
    expect(readFileSync(p, 'utf-8')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is idempotent: a second call keeps the same token and writes nothing new', () => {
    const p = agentTokenPath(AGENT, base)
    const before = readFileSync(p, 'utf-8')
    const r = ensureAgentToken(AGENT, base, MAIN_TOKEN)
    expect(r?.created).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe(before)
    expect(mode(p)).toBe(0o600)
  })

  it('tightens a drifted mode back to 0600 without rotating the token', () => {
    const p = agentTokenPath(AGENT, base)
    const before = readFileSync(p, 'utf-8')
    chmodSync(p, 0o644)
    expect(ensureAgentToken(AGENT, base, MAIN_TOKEN)?.created).toBe(false)
    expect(mode(p)).toBe(0o600)
    expect(readFileSync(p, 'utf-8')).toBe(before)
  })

  it('replaces a symlink (e.g. to the main token) with a fresh regular file', () => {
    mkdirSync(join(base, 'agent-b'), { recursive: true })
    const main = join(scratch.root, 'main-token')
    writeFileSync(main, MAIN_TOKEN)
    symlinkSync(main, agentTokenPath('agent-b', base))
    // the loader never trusts the link
    expect(loadAgentTokens(base, MAIN_TOKEN).has('agent-b')).toBe(false)
    const r = ensureAgentToken('agent-b', base, MAIN_TOKEN)
    expect(r?.created).toBe(true)
    const p = agentTokenPath('agent-b', base)
    expect(lstatSync(p).isFile()).toBe(true)
    expect(readFileSync(p, 'utf-8')).not.toBe(MAIN_TOKEN)
    expect(readFileSync(main, 'utf-8')).toBe(MAIN_TOKEN)
  })

  it('an agent token file holding a COPY of the main token is rotated, and ignored by the loader until then', () => {
    mkdirSync(join(base, 'agent-c'), { recursive: true })
    const p = agentTokenPath('agent-c', base)
    writeFileSync(p, MAIN_TOKEN, { mode: 0o600 })
    expect(loadAgentTokens(base, MAIN_TOKEN).has('agent-c')).toBe(false)
    const r = ensureAgentToken('agent-c', base, MAIN_TOKEN)
    expect(r?.created).toBe(true)
    const fresh = readFileSync(p, 'utf-8')
    expect(fresh).not.toBe(MAIN_TOKEN)
    expect(fresh).toMatch(/^[0-9a-f]{64}$/)
    expect(loadAgentTokens(base, MAIN_TOKEN).get('agent-c')).toBe(fresh)
  })

  it('a copied agent directory (two agents, ONE token value) authenticates neither, and the copy is rotated', () => {
    mkdirSync(join(base, 'agent-z'), { recursive: true })
    ensureAgentToken('agent-z', base, MAIN_TOKEN)
    const original = readFileSync(agentTokenPath('agent-z', base), 'utf-8')
    // `cp -r agents/agent-z agents/agent-y`
    mkdirSync(join(base, 'agent-y'), { recursive: true })
    writeFileSync(agentTokenPath('agent-y', base), original, { mode: 0o600 })
    const spy = vi.spyOn(logger, 'warn')
    try {
      const loaded = loadAgentTokens(base, MAIN_TOKEN)
      expect(loaded.has('agent-y')).toBe(false)
      expect(loaded.has('agent-z')).toBe(false)
      expect(matchAgentToken(original, loaded)).toBeNull()
      expect(spy.mock.calls.some((c) => String(c[1] ?? '').includes('several agents hold the SAME token'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
    // the next start of the copy rotates it; the original keeps its value
    expect(ensureAgentToken('agent-y', base, MAIN_TOKEN)?.created).toBe(true)
    const fresh = readFileSync(agentTokenPath('agent-y', base), 'utf-8')
    expect(fresh).not.toBe(original)
    expect(ensureAgentToken('agent-z', base, MAIN_TOKEN)?.created).toBe(false)
    const after = loadAgentTokens(base, MAIN_TOKEN)
    expect(after.get('agent-z')).toBe(original)
    expect(after.get('agent-y')).toBe(fresh)
  })

  it('an empty or short file is never a credential', () => {
    mkdirSync(join(base, 'agent-d'), { recursive: true })
    writeFileSync(agentTokenPath('agent-d', base), '', { mode: 0o600 })
    expect(loadAgentTokens(base, MAIN_TOKEN).has('agent-d')).toBe(false)
    writeFileSync(agentTokenPath('agent-d', base), 'short', { mode: 0o600 })
    expect(loadAgentTokens(base, MAIN_TOKEN).has('agent-d')).toBe(false)
    expect(ensureAgentToken('agent-d', base, MAIN_TOKEN)?.created).toBe(true)
  })

  it('never provisions the main agent, a missing dir or an implausible name', () => {
    mkdirSync(join(base, MAIN_AGENT_ID), { recursive: true })
    expect(ensureAgentToken(MAIN_AGENT_ID, base, MAIN_TOKEN)).toBeNull()
    expect(existsSync(agentTokenPath(MAIN_AGENT_ID, base))).toBe(false)
    expect(ensureAgentToken('no-such-agent', base, MAIN_TOKEN)).toBeNull()
    expect(ensureAgentToken('..', base, MAIN_TOKEN)).toBeNull()
  })

  it('dashboardTokenPathFor: main -> shared file; sub-agent -> own file only once it exists', () => {
    expect(dashboardTokenPathFor(MAIN_AGENT_ID, base)).toBe(mainTokenPath())
    expect(dashboardTokenPathFor(AGENT, base)).toBe(agentTokenPath(AGENT, base))
    mkdirSync(join(base, 'agent-e'), { recursive: true })
    expect(dashboardTokenPathFor('agent-e', base)).toBe(mainTokenPath())
  })

  it('migrates the literal shared-token path in the agent CLAUDE.md, anchored and idempotent', () => {
    const md = join(base, AGENT, 'CLAUDE.md')
    const main = '/opt/x/store/.dashboard-token'
    writeFileSync(md, `the token is in ${main}\ncurl -H "Authorization: Bearer $(cat ${main})" u\nrelative store/.dashboard-token stays\nbackup: ${main}.bak and ${main}-old and ${main}/x\n`)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    const after = readFileSync(md, 'utf-8')
    expect(after).not.toContain(`${main}\n`)
    expect(after).not.toContain(`${main})`)
    expect(after.split(agentTokenPath(AGENT, base)).length - 1).toBe(2)
    expect(after).toContain('relative store/.dashboard-token stays')
    // anchored: a longer path that merely STARTS with the token path is left alone
    expect(after).toContain(`backup: ${main}.bak and ${main}-old and ${main}/x`)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(false)
    // no per-agent token yet -> no rewrite
    writeFileSync(join(base, 'agent-e', 'CLAUDE.md'), `$(cat ${main})`)
    expect(migrateAgentClaudeMdTokenRefs('agent-e', base, main)).toBe(false)
  })

  it('after a host move, the agent\'s OWN per-agent path under the old root is re-anchored', () => {
    const md = join(base, AGENT, 'CLAUDE.md')
    const own = agentTokenPath(AGENT, base)
    const dir = basename(base) // 'agents' on an install; a scratch name here
    writeFileSync(md, `$(cat /old/root/${dir}/${AGENT}/.dashboard-token)\n$(cat /old/root/${dir}/other-agent/.dashboard-token)\n{{PROJECT_ROOT}}/${dir}/${AGENT}/.dashboard-token\n`)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, '/opt/x/store/.dashboard-token')).toBe(true)
    const after = readFileSync(md, 'utf-8')
    expect(after).toContain(`$(cat ${own})`)
    expect(after).not.toContain(`/old/root/${dir}/${AGENT}/`)
    // another agent's path and a template placeholder are not this agent's to touch
    expect(after).toContain(`/old/root/${dir}/other-agent/.dashboard-token`)
    expect(after).toContain(`{{PROJECT_ROOT}}/${dir}/${AGENT}/.dashboard-token`)
  })

  it('migration keeps the CLAUDE.md file mode and never rewrites a symlinked CLAUDE.md', () => {
    const main = '/opt/y/store/.dashboard-token'
    const md = join(base, AGENT, 'CLAUDE.md')
    writeFileSync(md, `curl -H "Authorization: Bearer $(cat ${main})" u\n`)
    chmodSync(md, 0o640)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    expect(mode(md)).toBe(0o640)
    mkdirSync(join(base, 'agent-f'), { recursive: true })
    ensureAgentToken('agent-f', base, MAIN_TOKEN)
    const target = join(scratch.root, 'agent-f-claude.md')
    writeFileSync(target, `$(cat ${main})`)
    symlinkSync(target, join(base, 'agent-f', 'CLAUDE.md'))
    expect(migrateAgentClaudeMdTokenRefs('agent-f', base, main)).toBe(false)
    expect(lstatSync(join(base, 'agent-f', 'CLAUDE.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe(`$(cat ${main})`)
  })

  it('a failing readdir of the agents dir is warned about, not silent', () => {
    const spy = vi.spyOn(logger, 'warn')
    try {
      expect(loadAgentTokens(join(scratch.root, 'no-such-dir'), MAIN_TOKEN).size).toBe(0)
      expect(spy.mock.calls.some((c) => String(c[1] ?? '').includes('cannot list the agents directory'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveAuth with agent tokens', () => {
  const base = join(scratch.root, 'resolve-agents')
  let agentTok = ''
  beforeAll(() => {
    mkdirSync(join(base, AGENT), { recursive: true })
    ensureAgentToken(AGENT, base, MAIN_TOKEN)
    agentTok = readFileSync(agentTokenPath(AGENT, base), 'utf-8')
  })
  const url = new URL('http://127.0.0.1/api/memories')

  it('main token -> plain token principal (byte-identical to before)', () => {
    const resolver = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })
    expect(resolveAuth(mkReq({ authorization: `Bearer ${MAIN_TOKEN}` }), url, url.pathname, 'GET', MAIN_TOKEN, resolver))
      .toStrictEqual({ kind: 'token' })
  })

  it('agent token -> token principal tagged with the agent', () => {
    const resolver = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })
    expect(resolveAuth(mkReq({ authorization: `Bearer ${agentTok}` }), url, url.pathname, 'GET', MAIN_TOKEN, resolver))
      .toStrictEqual({ kind: 'token', agent: AGENT })
  })

  it('an agent token is NOT accepted on the SSE pane-stream ?token= lane (pane streams are not agent API)', () => {
    const resolver = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })
    const sse = new URL(`http://127.0.0.1/api/agents/${AGENT}/pane/stream?token=${agentTok}`)
    expect(resolveAuth(mkReq({}), sse, sse.pathname, 'GET', MAIN_TOKEN, resolver)).toStrictEqual({ kind: 'none' })
    const main = new URL(`http://127.0.0.1/api/agents/${AGENT}/pane/stream?token=${MAIN_TOKEN}`)
    expect(resolveAuth(mkReq({}), main, main.pathname, 'GET', MAIN_TOKEN, resolver)).toStrictEqual({ kind: 'token' })
  })

  it('unknown token -> none; timing-safe matcher handles any length', () => {
    const resolver = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })
    expect(resolveAuth(mkReq({ authorization: 'Bearer nope' }), url, url.pathname, 'GET', MAIN_TOKEN, resolver))
      .toStrictEqual({ kind: 'none' })
    expect(matchAgentToken('', new Map([[AGENT, agentTok]]))).toBeNull()
    expect(matchAgentToken('x'.repeat(500), new Map([[AGENT, agentTok]]))).toBeNull()
  })

  it('without a resolver (an install that never wires one) nothing changes', () => {
    expect(resolveAuth(mkReq({ authorization: `Bearer ${agentTok}` }), url, url.pathname, 'GET', MAIN_TOKEN))
      .toStrictEqual({ kind: 'none' })
  })

  it('a token provisioned in-process is accepted IMMEDIATELY (cache invalidated on created=true)', () => {
    const resolver = createAgentTokenResolver({ baseDir: base, ttlMs: 60_000, now: () => 0, mainToken: MAIN_TOKEN })
    expect(resolver('0'.repeat(64))).toBeNull() // primes the cache
    mkdirSync(join(base, 'agent-g'), { recursive: true })
    expect(ensureAgentToken('agent-g', base, MAIN_TOKEN)?.created).toBe(true)
    const tok = readFileSync(agentTokenPath('agent-g', base), 'utf-8')
    expect(resolver(tok)).toBe('agent-g')
  })

  it('a token file dropped in by hand is picked up after the cache TTL, not before', () => {
    let t = 0
    const resolver = createAgentTokenResolver({ baseDir: base, ttlMs: 1000, now: () => t, mainToken: MAIN_TOKEN })
    expect(resolver('0'.repeat(64))).toBeNull() // primes the cache
    mkdirSync(join(base, 'agent-h'), { recursive: true })
    const tok = 'e'.repeat(64)
    writeFileSync(agentTokenPath('agent-h', base), tok, { mode: 0o600 })
    t = 500
    expect(resolver(tok)).toBeNull()
    t = 1000
    expect(resolver(tok)).toBe('agent-h')
  })
})

describe('AGENT_DASHBOARD_TOKENS=0 (rollback)', () => {
  const base = join(scratch.root, 'off-agents')
  let agentTok = ''
  beforeAll(() => {
    mkdirSync(join(base, AGENT), { recursive: true })
    ensureAgentToken(AGENT, base, MAIN_TOKEN)
    agentTok = readFileSync(agentTokenPath(AGENT, base), 'utf-8')
  })

  it('the switch is on by default and reads the usual off spellings', () => {
    expect(agentTokensEnabled()).toBe(true)
    for (const v of ['0', 'false', 'no', 'off', ' OFF ']) {
      setSwitch(v)
      expect(agentTokensEnabled(), v).toBe(false)
    }
    setSwitch('1')
    expect(agentTokensEnabled()).toBe(true)
  })

  it('a per-agent token still authenticates, as the unrestricted shared-token principal', async () => {
    setSwitch('0')
    const resolver = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })
    const url = new URL('http://127.0.0.1/api/schedules')
    expect(resolveAuth(mkReq({ authorization: `Bearer ${agentTok}` }), url, url.pathname, 'POST', MAIN_TOKEN, resolver))
      .toStrictEqual({ kind: 'token' })
  })

  it('generated recipes and the migration point back at the shared file', () => {
    const md = join(base, AGENT, 'CLAUDE.md')
    const own = agentTokenPath(AGENT, base)
    const main = '/opt/z/store/.dashboard-token'
    writeFileSync(md, `curl -H "Authorization: Bearer $(cat ${own})" u\n`)
    setSwitch('off')
    expect(dashboardTokenPathFor(AGENT, base)).toBe(mainTokenPath())
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    expect(readFileSync(md, 'utf-8')).toBe(`curl -H "Authorization: Bearer $(cat ${main})" u\n`)
    // and forward again once the switch is back on
    setSwitch(undefined)
    expect(migrateAgentClaudeMdTokenRefs(AGENT, base, main)).toBe(true)
    expect(readFileSync(md, 'utf-8')).toBe(`curl -H "Authorization: Bearer $(cat ${own})" u\n`)
  })
})

describe('HTTP: the dashboard gate in front of the real routes', () => {
  const base = join(scratch.root, 'http-agents')
  let server: http.Server
  let origin = ''
  let agentTok = ''

  beforeAll(async () => {
    mkdirSync(join(base, AGENT), { recursive: true })
    ensureAgentToken(AGENT, base, MAIN_TOKEN)
    agentTok = readFileSync(agentTokenPath(AGENT, base), 'utf-8')
    const resolveAgentToken = createAgentTokenResolver({ baseDir: base, mainToken: MAIN_TOKEN })
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method || 'GET'
      const auth = gateRequest(req, res, url, path, method, { dashboardToken: MAIN_TOKEN, resolveAgentToken, mainAgentId: MAIN_AGENT_ID })
      if (auth === null) return
      const ctx = {
        req, res, path, method, url, fedPeer: null,
        auth: auth.kind === 'token' ? (auth.agent ? { kind: 'token' as const, agent: auth.agent } : { kind: 'token' as const }) : undefined,
      }
      try {
        if (await tryHandleMessages(ctx)) return
        if (await tryHandleKanban(ctx)) return
        if (await tryHandleSchedules(ctx)) return
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

  const sched = (name: string) => ({ name, description: 'd', prompt: 'p', schedule: '0 8 * * *', agent: MAIN_AGENT_ID, type: 'task' })

  it('sanity: schedule writes land in the scratch HOME, never the real one', () => {
    expect(SCHEDULED_TASKS_DIR.startsWith(scratch.home)).toBe(true)
  })

  it('main token: schedule create / update / delete -> 2xx', async () => {
    const c = await call('POST', '/api/schedules', MAIN_TOKEN, sched('main-agent-task'))
    expect(c.status).toBe(200)
    expect(existsSync(join(SCHEDULED_TASKS_DIR, 'main-agent-task', 'task-config.json'))).toBe(true)
    expect((await call('PUT', '/api/schedules/main-agent-task', MAIN_TOKEN, { description: 'u' })).status).toBe(200)
    expect((await call('DELETE', '/api/schedules/main-agent-task', MAIN_TOKEN)).status).toBe(200)
  })

  it('sub-agent token: every schedule write -> 403 naming the rule, nothing written', async () => {
    // a target that exists, so a 403 cannot be confused with a 404
    expect((await call('POST', '/api/schedules', MAIN_TOKEN, sched('existing-task'))).status).toBe(200)
    const cases: Array<[string, string, unknown?]> = [
      ['POST', '/api/schedules', sched('sub-agent-task')],
      ['PUT', '/api/schedules/existing-task', { prompt: 'overwritten' }],
      ['PATCH', '/api/schedules/existing-task', { prompt: 'overwritten' }],
      ['DELETE', '/api/schedules/existing-task'],
      ['POST', '/api/schedules/existing-task/toggle'],
      ['POST', '/api/schedules/existing-task/run'],
    ]
    for (const [method, path, body] of cases) {
      const r = await call(method, path, agentTok, body)
      expect(r.status, `${method} ${path}`).toBe(403)
      expect(r.json).toEqual({ error: SCHEDULE_DENIED, rule: 'schedule-writes-main-agent-only', agent: AGENT, main_agent: MAIN_AGENT_ID })
    }
    expect(existsSync(join(SCHEDULED_TASKS_DIR, 'sub-agent-task'))).toBe(false)
    expect(existsSync(join(SCHEDULED_TASKS_DIR, 'existing-task', 'task-config.json'))).toBe(true)
    expect(readFileSync(join(SCHEDULED_TASKS_DIR, 'existing-task', 'SKILL.md'), 'utf-8')).not.toContain('overwritten')
  })

  it('sub-agent token: GET schedules, POST messages and POST kanban -> 2xx', async () => {
    const g = await call('GET', '/api/schedules', agentTok)
    expect(g.status).toBe(200)
    expect((await call('GET', '/api/schedules/summary', agentTok)).status).toBe(200)
    const m = await call('POST', '/api/messages', agentTok, { from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'agent token test' })
    expect(m.status).toBe(200)
    expect(typeof m.json.id).toBe('number')
    const k = await call('POST', '/api/kanban', agentTok, { title: 'agent token test card' })
    expect(k.status).toBe(200)
    expect(k.json.ok).toBe(true)
  })

  it('unknown or missing token -> 401, exactly as before', async () => {
    for (const tok of ['nope', '0'.repeat(64), null]) {
      for (const [method, path] of [['GET', '/api/schedules'], ['POST', '/api/schedules'], ['POST', '/api/messages']] as const) {
        const r = await call(method, path, tok, method === 'POST' ? {} : undefined)
        expect(r.status, `${method} ${path} tok=${tok === null ? 'none' : 'bad'}`).toBe(401)
        expect(r.json).toEqual({ error: 'Unauthorized' })
      }
    }
  })
})

describe('web.ts / agent-process.ts wiring (source-level)', () => {
  const WEB = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web.ts'), 'utf-8')
  const PROC = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web', 'agent-process.ts'), 'utf-8')
  it('a start provisions the token first and migrates the CLAUDE.md AFTER the host-move re-anchoring (one start converges)', () => {
    const provision = PROC.indexOf('if (agentTokensEnabled()) ensureAgentToken(name)')
    const reanchor = PROC.indexOf('    ensureProjectRootInClaudeMd(name)\n')
    const migrate = PROC.indexOf('migrateAgentClaudeMdTokenRefs(name)')
    expect(provision).toBeGreaterThan(0)
    expect(reanchor).toBeGreaterThan(provision)
    expect(migrate).toBeGreaterThan(reanchor)
  })
  it('the dashboard runs gateRequest with a resolver that refuses a copy of the served main token', () => {
    expect(WEB).toContain('createAgentTokenResolver({ mainToken: DASHBOARD_TOKEN })')
    expect(WEB).toMatch(/gateRequest\(req, res, url, path, method, \{\s*dashboardToken: DASHBOARD_TOKEN,\s*resolveAgentToken,/)
  })
})
