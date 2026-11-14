// OWNERGATE3-1104: the third round of owner gates. The shared access token (every sub-agent can read it) must not
// type into an agent's terminal (POST /api/agents/:name/keys), switch terminal input on or off, start an agent's
// Claude login (the scripted /login, POST /auth/init), install a connector from the catalog (`claude mcp add --scope
// user`), rename the owner and the agent (onboarding identity), assign a global skill to agents (it also removes the
// skill from every other agent), or change an agent's auto-restart schedule, voice settings or the curated
// OpenRouter model list. Those need the owner (mayActAsOwner): the browser login, the token with the owner's session
// cookie, or the Bridge's full key with that cookie. Before the first dashboard login exists the bare token still
// passes (the customer first-run path), measured here for onboarding identity. The GETs stay open, and so does
// PUT /api/agents/:name/context-guard: a direction gate (review, Samu 69602): the token may strengthen, weakening needs the owner.
// A refused call writes NOTHING (measured on the bytes) and reaches no tmux, no `claude` and no cp.
//
// Side effects that would leave the process are mocked: node:child_process (execFile and spawn: no tmux, no `claude
// mcp add`, no cp), the agent-process tmux helpers (running check, sendPromptToSession, capturePane), the channels
// restart, the vault, and node:os homedir (a sandbox, so the global skills dir and ~/.claude.json are never the real
// ones). Files this checkout's store/ holds are saved and restored.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A path only (created in beforeAll): vi.mock factories are hoisted above the imports.
const HOME_SANDBOX = vi.hoisted(() => `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/og3-home-${process.pid}-${Date.now()}`)
vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  return { ...real, default: { ...real, homedir: () => HOME_SANDBOX }, homedir: () => HOME_SANDBOX }
})

const vaultSecrets = new Map<string, string>()
vi.mock('../web/vault.js', async (orig) => ({
  ...(await orig<typeof import('../web/vault.js')>()),
  setSecret: vi.fn((id: string, _label: string, value: string) => { vaultSecrets.set(id, value) }),
  deleteSecret: vi.fn((id: string) => vaultSecrets.delete(id)),
  getSecret: vi.fn((id: string) => vaultSecrets.get(id) ?? null),
}))
const hardRestartMarveenChannels = vi.fn(() => ({ ok: true }))
vi.mock('../web/channel-monitor.js', async (orig) => ({
  ...(await orig<typeof import('../web/channel-monitor.js')>()),
  hardRestartMarveenChannels: () => hardRestartMarveenChannels(),
}))
let agentRunning = true
const sendPromptToSession = vi.fn(async () => {})
const capturePane = vi.fn(() => 'Browser login: https://claude.ai/oauth/login?code=og3test')
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => agentRunning,
  sendPromptToSession: (...a: unknown[]) => (sendPromptToSession as (...x: unknown[]) => Promise<void>)(...a),
  capturePane: (...a: unknown[]) => (capturePane as (...x: unknown[]) => string)(...a),
}))
// Every child process (tmux send-keys and has-session, `claude mcp add`, cp) goes through these two: they record the
// call and fail it, so a call that slipped through is both counted and harmless.
const execFileMock = vi.fn((...args: unknown[]) => {
  const cb = args.find((a) => typeof a === 'function') as ((e: Error) => void) | undefined
  cb?.(new Error('execFile is mocked in owner-gate-round3.test.ts'))
  return { stdin: { end() {} } }
})
const spawnMock = vi.fn(() => {
  const handlers: Record<string, (x?: unknown) => void> = {}
  const child = { on(ev: string, fn: (x?: unknown) => void) { handlers[ev] = fn; if (ev === 'exit') setTimeout(() => fn(1), 0); return child } }
  return child
})
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...a: unknown[]) => execFileMock(...a),
  spawn: (...a: unknown[]) => (spawnMock as (...x: unknown[]) => unknown)(...a),
}))

const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { tryHandleAgentTerminal } = await import('../web/routes/agent-terminal.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')
const { tryHandleSkills } = await import('../web/routes/skills.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')
const { readTerminalInputEnabled, writeTerminalInputEnabled } = await import('../web/terminal-input-store.js')
const { OPENROUTER_MANUAL_FILE } = await import('../web/openrouter-models.js')

const AGENT = '__test-og3-agent'
const PEER = '__test-og3-peer'
const DIR = agentDir(AGENT)
const PEER_DIR = agentDir(PEER)
const SKILL = '__og3-skill'
const GLOBAL_SKILL_DIR = join(HOME_SANDBOX, '.claude', 'skills', SKILL)
const AGENT_SKILL_DIR = join(DIR, '.claude', 'skills', SKILL)
// The main agent's local skills live in the checkout's own .claude/skills (every sub-agent's ancestor folder).
const MAIN_SKILLS_ROOT = join(PROJECT_ROOT, '.claude', 'skills')
const mainSkillsRootExisted = existsSync(MAIN_SKILLS_ROOT)
const MAIN_SKILL_DIR = join(MAIN_SKILLS_ROOT, SKILL)

type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; device?: string; tokenAgent?: string } | undefined
type Handler = (ctx: any, webDir: string) => Promise<boolean>
async function hit(handler: Handler, method: string, path: string, auth: Auth, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as any).url = path
  ;(req as any).method = method
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth }
  expect(await handler(ctx, join(PROJECT_ROOT, 'web'))).toBe(true)
  return { status: out.status || 200, body: out.body }
}
const refusedByOwnerGate = (r: { status: number, body: any }) => r.status === 403 && r.body?.code === 'owner_session_required'
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : null)
const list = (p: string) => (existsSync(p) ? readdirSync(p).sort() : null)

let ownerId = 0
const ownerCookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}` })
const TOKEN: Auth = { kind: 'token' }
const SESSION: Auth = { kind: 'session' }
const SUBAGENT: Auth = { kind: 'token', tokenAgent: 'samu' }
const BRIDGE: Auth = { kind: 'device', scope: 'full', device: 'Bridge' }
const OPERATOR: Auth = { kind: 'device', scope: 'operator', device: 'Op' }
const OWNER_LANES: Array<[string, Auth, () => Record<string, string>]> = [
  ['session', SESSION, () => ({})],
  ['token + owner cookie', TOKEN, ownerCookie],
  ['full device key + owner cookie', BRIDGE, ownerCookie],
]
const NON_OWNER: Array<[string, Auth, () => Record<string, string>]> = [
  ['bare shared token', TOKEN, () => ({})],
  ['sub-agent token + owner cookie', SUBAGENT, ownerCookie],
  ['bare full device key', BRIDGE, () => ({})],
  ['operator key + owner cookie', OPERATOR, ownerCookie],
]

// --- the checkout's store files a write could touch: saved and restored -----------------------------------------
const STORE_ROOT = join(PROJECT_ROOT, 'store')
const storeRootExisted = existsSync(STORE_ROOT)
const AGENTS_ROOT = join(PROJECT_ROOT, 'agents')
const agentsRootExisted = existsSync(AGENTS_ROOT)
const TERMINAL_INPUT_FILE = join(STORE_ROOT, 'terminal-input.json')
const AUTO_RESTART_FILE = join(STORE_ROOT, 'auto-restart.json')
const CONTEXT_GUARD_FILE = join(STORE_ROOT, 'context-guard.json')
// The identity route writes the checkout's .env and renames inside CLAUDE.md / SOUL.md (paths fixed to PROJECT_ROOT):
// a regression that lets the bare token through would rewrite them, so they are saved and restored as well (measured
// need: a gate-removed mutant run created a .env here).
const IDENTITY_FILES = ['.env', 'CLAUDE.md', 'SOUL.md'].map((f) => join(PROJECT_ROOT, f))
const SAVED = [TERMINAL_INPUT_FILE, AUTO_RESTART_FILE, CONTEXT_GUARD_FILE, OPENROUTER_MANUAL_FILE, ...IDENTITY_FILES]
const saved = new Map<string, string | null>()

function seed() {
  for (const d of [DIR, PEER_DIR]) rmSync(d, { recursive: true, force: true })
  mkdirSync(AGENT_SKILL_DIR, { recursive: true })
  mkdirSync(PEER_DIR, { recursive: true })
  writeFileSync(join(DIR, 'CLAUDE.md'), '# og3\n')
  writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify({ model: 'claude-opus-5' }, null, 2))
  writeFileSync(join(AGENT_SKILL_DIR, 'SKILL.md'), '---\nname: og3 copy\n---\n')
  writeFileSync(join(PEER_DIR, 'CLAUDE.md'), '# peer\n')
  rmSync(GLOBAL_SKILL_DIR, { recursive: true, force: true })
  mkdirSync(GLOBAL_SKILL_DIR, { recursive: true })
  writeFileSync(join(GLOBAL_SKILL_DIR, 'SKILL.md'), '---\nname: og3 global\n---\n')
  rmSync(MAIN_SKILL_DIR, { recursive: true, force: true })
  mkdirSync(MAIN_SKILL_DIR, { recursive: true })
  writeFileSync(join(MAIN_SKILL_DIR, 'SKILL.md'), '---\nname: og3 main\n---\n')
}
const state = () => ({
  terminalInput: read(TERMINAL_INPUT_FILE),
  terminalInputEnabled: readTerminalInputEnabled(),
  autoRestart: read(AUTO_RESTART_FILE),
  contextGuard: read(CONTEXT_GUARD_FILE),
  openrouterManual: read(OPENROUTER_MANUAL_FILE),
  agentConfig: read(join(DIR, 'agent-config.json')),
  agentSkill: list(AGENT_SKILL_DIR),
  agentSkillMd: read(join(AGENT_SKILL_DIR, 'SKILL.md')),
  globalSkill: read(join(GLOBAL_SKILL_DIR, 'SKILL.md')),
  mainSkill: read(join(MAIN_SKILL_DIR, 'SKILL.md')),
  peerSkills: list(join(PEER_DIR, '.claude', 'skills')),
  identity: IDENTITY_FILES.map(read),
  claudeJson: read(join(HOME_SANDBOX, '.claude.json')),
})
const noChildProcess = () => {
  expect(execFileMock).not.toHaveBeenCalled()
  expect(spawnMock).not.toHaveBeenCalled()
  expect(sendPromptToSession).not.toHaveBeenCalled()
  expect(capturePane).not.toHaveBeenCalled()
  expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
}

beforeAll(() => {
  initDatabase(":memory:")
  mkdirSync(HOME_SANDBOX, { recursive: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  for (const p of SAVED) saved.set(p, read(p))
})
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  seed()
  agentRunning = true
  // Terminal input ON: the refusal below is the owner gate, not the toggle.
  writeTerminalInputEnabled(true)
  vaultSecrets.clear()
  vaultSecrets.set('openrouter-fleet-key', 'sk-or-og3-test')
  for (const m of [execFileMock, spawnMock, sendPromptToSession, capturePane, hardRestartMarveenChannels]) m.mockClear()
})
afterAll(() => {
  for (const d of [DIR, PEER_DIR, MAIN_SKILL_DIR]) rmSync(d, { recursive: true, force: true })
  if (!mainSkillsRootExisted && existsSync(MAIN_SKILLS_ROOT) && readdirSync(MAIN_SKILLS_ROOT).length === 0) rmSync(MAIN_SKILLS_ROOT, { recursive: true })
  for (const [p, v] of saved) { if (v !== null) writeFileSync(p, v); else rmSync(p, { force: true }) }
  if (!agentsRootExisted && existsSync(AGENTS_ROOT) && readdirSync(AGENTS_ROOT).length === 0) rmSync(AGENTS_ROOT, { recursive: true })
  if (!storeRootExisted && existsSync(STORE_ROOT) && readdirSync(STORE_ROOT).length === 0) rmSync(STORE_ROOT, { recursive: true })
  rmSync(HOME_SANDBOX, { recursive: true, force: true })
})

// --- the gated routes -------------------------------------------------------------------------------------------
type Case = {
  label: string
  handler: Handler
  method: string
  path: string
  body?: unknown
  // An owner-lane call: either the write is measured, or (when that would need tmux/the CLI) only "not the gate".
  ownerCheck: (r: { status: number; body: any }) => void
}
const CASES: Case[] = [
  {
    label: 'POST /api/agents/:name/keys', handler: tryHandleAgentTerminal, method: 'POST', path: `/api/agents/${AGENT}/keys`,
    body: { keys: 'rm -rf ~' },
    // Past the gate, the toggle and the running check: the send-keys call is made (the mock fails it: 500).
    ownerCheck: (r) => {
      expect(r.status).toBe(500)
      expect(execFileMock).toHaveBeenCalledTimes(1)
      expect((execFileMock.mock.calls[0][1] as string[])).toContain('send-keys')
    },
  },
  {
    label: 'POST /api/terminal-input (off)', handler: tryHandleAgentTerminal, method: 'POST', path: '/api/terminal-input',
    body: { enabled: false },
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(r.body.enabled).toBe(false); expect(readTerminalInputEnabled()).toBe(false) },
  },
  {
    label: 'POST /api/agents/:name/login', handler: tryHandleAgentTerminal, method: 'POST', path: `/api/agents/${AGENT}/login`,
    body: { phase: 'start' },
    ownerCheck: (r) => {
      expect(r.status).toBe(500)
      expect(r.body.error).toBe('login sequence failed')
      expect(execFileMock).toHaveBeenCalledTimes(1)
    },
  },
  {
    label: 'POST /api/agents/:name/auth/init', handler: tryHandleAgents, method: 'POST', path: `/api/agents/${AGENT}/auth/init`,
    ownerCheck: (r) => {
      expect(r.status).toBe(200)
      expect(r.body.authUrl).toBe('https://claude.ai/oauth/login?code=og3test')
      expect(sendPromptToSession).toHaveBeenCalledTimes(1)
    },
  },
  {
    // An id not in the catalog: the owner lanes stop at the lookup right after the gate, before any spawn.
    label: 'POST /api/mcp-catalog/:id/install', handler: tryHandleConnectors, method: 'POST', path: '/api/mcp-catalog/__og3-not-in-catalog/install',
    body: { env: { OG3: 'x' } },
    ownerCheck: (r) => { expect(r.status).toBe(404); expect(r.body.error).toBe('Item not found in catalog'); expect(execFileMock).not.toHaveBeenCalled() },
  },
  {
    // Review (Dani 69599): the uninstall twin. An id not in the catalog: the owner lanes stop at the lookup.
    label: 'DELETE /api/mcp-catalog/:id/uninstall', handler: tryHandleConnectors, method: 'DELETE', path: '/api/mcp-catalog/__og3-not-in-catalog/uninstall',
    ownerCheck: (r) => { expect(r.status).toBe(404); expect(r.body.error).toBe('Item not found in catalog'); expect(execFileMock).not.toHaveBeenCalled() },
  },
  {
    // Both names given: the owner lanes would write .env and the persona files, so they stop at validation here
    // (a missing owner name, 400) right after the gate; the bare token is refused with a complete body.
    label: 'POST /api/onboarding/identity', handler: tryHandleOnboarding as Handler, method: 'POST', path: '/api/onboarding/identity',
    body: { agentName: 'Evil', ownerName: 'Attacker' },
    ownerCheck: () => { /* replaced per call below */ },
  },
  {
    // agents: [] -> the route removes the skill from every agent that has a copy; no cp is needed.
    label: 'POST /api/skills/:name/assign', handler: tryHandleSkills as Handler, method: 'POST', path: `/api/skills/${SKILL}/assign`,
    body: { agents: [] },
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(existsSync(AGENT_SKILL_DIR)).toBe(false); expect(execFileMock).not.toHaveBeenCalled() },
  },
  {
    // LOW-F2-4 (self-audit): the global branch rewrites ~/.claude/skills/<name>/SKILL.md outside the quarantine queue.
    label: 'PUT /api/skills/:name (global)', handler: tryHandleSkills as Handler, method: 'PUT', path: `/api/skills/${SKILL}`,
    body: { content: '---\nname: og3 edited\n---\n' },
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(read(join(GLOBAL_SKILL_DIR, 'SKILL.md'))).toBe('---\nname: og3 edited\n---\n') },
  },
  {
    // LOW-F2-5 (self-audit): ?agent=<main agent> rewrites PROJECT_ROOT/.claude/skills, which every sub-agent loads.
    label: 'PUT /api/skills/:name?agent=<main agent>', handler: tryHandleSkills as Handler, method: 'PUT', path: `/api/skills/${SKILL}?agent=${MAIN_AGENT_ID}`,
    body: { content: '---\nname: og3 main edited\n---\n' },
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(read(join(MAIN_SKILL_DIR, 'SKILL.md'))).toBe('---\nname: og3 main edited\n---\n') },
  },
  {
    // SKILLPUTSCOPE1114: ?agent=<a sub-agent> let any holder of the shared token (every agent) rewrite ANOTHER agent's skill.
    label: 'PUT /api/skills/:name?agent=<sub-agent>', handler: tryHandleSkills as Handler, method: 'PUT', path: `/api/skills/${SKILL}?agent=${AGENT}`,
    body: { content: '---\nname: og3 agent edited\n---\n' },
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(read(join(AGENT_SKILL_DIR, 'SKILL.md'))).toBe('---\nname: og3 agent edited\n---\n') },
  },
  {
    // SKILLPUTSCOPE1114: the gate is first, so a non-owner cannot tell an unknown agent name (404 only for the owner).
    label: 'PUT /api/skills/:name?agent=<unknown agent>', handler: tryHandleSkills as Handler, method: 'PUT', path: `/api/skills/${SKILL}?agent=__og3-no-such-agent`,
    body: { content: 'x' },
    ownerCheck: (r) => { expect(r.status).toBe(404) },
  },
  {
    // An unknown key: the owner lanes stop at the field check (400) right after the gate, so store/ stays as it is.
    label: 'PUT /api/agents/:name/auto-restart', handler: tryHandleAgents, method: 'PUT', path: `/api/agents/${AGENT}/auto-restart`,
    body: { enabled: true, og3Unknown: 1 },
    ownerCheck: (r) => { expect(r.status).toBe(400); expect(r.body.rejected).toEqual(['og3Unknown']) },
  },
  {
    label: 'PUT /api/agents/:name/voice-config', handler: tryHandleAgents, method: 'PUT', path: `/api/agents/${AGENT}/voice-config`,
    body: { responseMode: 'voice' },
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(r.body.responseMode).toBe('voice'); expect(read(join(DIR, 'agent-config.json'))).toContain('voice') },
  },
  {
    label: 'POST /api/openrouter/manual', handler: tryHandleAgents, method: 'POST', path: '/api/openrouter/manual',
    body: { name: 'no id' },
    ownerCheck: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('id is required') },
  },
]
// The identity owner lanes send a body without the owner name (no .env/persona write, see above).
const ownerBody = (c: Case) => (c.label === 'POST /api/onboarding/identity' ? { agentName: 'Evil' } : c.body)
const ownerCheckFor = (c: Case) => (c.label === 'POST /api/onboarding/identity'
  ? (r: { status: number; body: any }) => { expect(r.status).toBe(400); expect(r.body.reason).toBe('missing') }
  : c.ownerCheck)

describe('OWNERGATE3-1104: the bare shared token is refused, nothing changes, nothing runs', () => {
  for (const c of CASES) {
    it(c.label, async () => {
      const before = state()
      const r = await hit(c.handler, c.method, c.path, TOKEN, c.body)
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(typeof r.body.error).toBe('string')
      expect(r.body.error).not.toBe('')
      expect(state()).toEqual(before)
      noChildProcess()
    })
  }
  it('terminal input ON is refused too (the shared token cannot switch typing on)', async () => {
    writeTerminalInputEnabled(false)
    const before = state()
    const r = await hit(tryHandleAgentTerminal, 'POST', '/api/terminal-input', TOKEN, { enabled: true })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(readTerminalInputEnabled()).toBe(false)
    expect(state()).toEqual(before)
  })
})

describe('OWNERGATE3-1104: the owner lanes pass the gate', () => {
  for (const c of CASES) {
    for (const [lane, auth, headers] of OWNER_LANES) {
      it(`${c.label}: ${lane}`, async () => {
        const r = await hit(c.handler, c.method, c.path, auth, ownerBody(c), headers())
        expect(refusedByOwnerGate(r)).toBe(false)
        ownerCheckFor(c)(r)
      })
    }
  }
  it('terminal input ON: the owner session switches it on', async () => {
    writeTerminalInputEnabled(false)
    const r = await hit(tryHandleAgentTerminal, 'POST', '/api/terminal-input', SESSION, { enabled: true })
    expect(r.status).toBe(200)
    expect(readTerminalInputEnabled()).toBe(true)
  })
})

describe('OWNERGATE3-1104: the non-owner lanes are refused', () => {
  for (const c of CASES) {
    for (const [lane, auth, headers] of NON_OWNER) {
      it(`${c.label}: ${lane}`, async () => {
        const before = state()
        const r = await hit(c.handler, c.method, c.path, auth, c.body, headers())
        expect(refusedByOwnerGate(r)).toBe(true)
        expect(state()).toEqual(before)
        noChildProcess()
      })
    }
  }
})

describe('OWNERGATE3-1104: first-run branch (zero dashboard users), measured', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
  })
  it('POST /api/onboarding/identity: the bare token passes the gate and stops at validation', async () => {
    const before = state()
    const r = await hit(tryHandleOnboarding as Handler, 'POST', '/api/onboarding/identity', TOKEN, { agentName: 'Robi' })
    expect(refusedByOwnerGate(r)).toBe(false)
    expect(r.status).toBe(400)
    expect(r.body.reason).toBe('missing')
    expect(state()).toEqual(before)
  })
  it('a sub-agent token is still refused before the first login', async () => {
    const r = await hit(tryHandleOnboarding as Handler, 'POST', '/api/onboarding/identity', SUBAGENT, { agentName: 'Evil', ownerName: 'Attacker' })
    expect(refusedByOwnerGate(r)).toBe(true)
  })
  // Every other OWNERGATE3-1104 route takes the strict gate (#2520 review): before the first login the bare token is
  // refused, the 403 says to create a login (setup_required), and nothing changes or runs.
  for (const c of CASES.filter((x) => x.path !== '/api/onboarding/identity')) {
    it(`${c.label}: zero users + bare token -> 403 setup_required, nothing changes`, async () => {
      const before = state()
      const r = await hit(c.handler, c.method, c.path, TOKEN, c.body)
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(r.body.setup_required).toBe(true)
      expect(state()).toEqual(before)
      noChildProcess()
    })
  }
  it('terminal input ON: zero users + bare token -> 403 setup_required', async () => {
    const r = await hit(tryHandleAgentTerminal, 'POST', '/api/terminal-input', TOKEN, { enabled: true })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(r.body.setup_required).toBe(true)
  })
})

describe('controls: what stays open to the bare token', () => {
  it('GET /api/terminal-input', async () => {
    const r = await hit(tryHandleAgentTerminal, 'GET', '/api/terminal-input', TOKEN)
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(true)
  })
  it('GET voice-config, context-guard, auto-restart neighbours and the OpenRouter list', async () => {
    expect((await hit(tryHandleAgents, 'GET', `/api/agents/${AGENT}/voice-config`, TOKEN)).status).toBe(200)
    expect((await hit(tryHandleAgents, 'GET', `/api/agents/${AGENT}/context-guard`, TOKEN)).status).toBe(200)
    expect((await hit(tryHandleAgents, 'GET', '/api/openrouter/manual', TOKEN)).status).toBe(200)
  })
  it('PUT context-guard: an unknown key is 400 before the direction gate, nothing written (strengthening stays on the token, see below)', async () => {
    const before = state()
    const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}/context-guard`, TOKEN, { og3Unknown: 1 })
    expect(refusedByOwnerGate(r)).toBe(false)
    expect(r.status).toBe(400)
    expect(state()).toEqual(before)
  })
})

// Review (Dani 69599): the catalog uninstall with a REAL catalog id and the bare token. The refusal must not depend
// on the lookup: `claude mcp remove` is never spawned and the answer is the owner gate's.
describe('OWNERGATE3-1104: catalog uninstall of a real item', () => {
  it('DELETE /api/mcp-catalog/:id/uninstall with the bare token: refused, `claude mcp remove` never spawned', async () => {
    for (const id of ['notion', 'filesystem']) {
      const r = await hit(tryHandleConnectors, 'DELETE', `/api/mcp-catalog/${id}/uninstall`, TOKEN)
      expect(refusedByOwnerGate(r), id).toBe(true)
    }
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

// Review (Samu 69602, Dani 69599): PUT context-guard is a DIRECTION gate. The shared token may only strengthen a
// guard (the main agent arms other agents' guards with it); every weakening needs the owner, on any agent.
const { contextGuardWeakenings, DEFAULT_CONTEXT_GUARD: CG_DEFAULT } = await import('../context-guard.js')
// The in-memory test DB back to "no dashboard login yet", the same reset the first-run block above uses.
const resetOwnersForTest = () => { getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users'); _clearSessionCacheForTest() }
describe('OWNERGATE3-1104: contextGuardWeakenings (pure)', () => {
  const armed = { ...CG_DEFAULT, enabled: true, idleFlushEnabled: true, dailyHandoffEnabled: true, dailyHandoffTime: '03:00', limitTokens: 500_000 }
  it('switches going off are weakenings; going on are not', () => {
    expect(contextGuardWeakenings(armed, { ...armed, enabled: false, saturationRestart: false, idleFlushEnabled: false, dailyHandoffEnabled: false }).sort())
      .toEqual(['dailyHandoffEnabled', 'enabled', 'idleFlushEnabled', 'saturationRestart'])
    expect(contextGuardWeakenings({ ...armed, enabled: false }, armed)).toEqual([])
  })
  it('a number going up is a weakening; going down is not', () => {
    const up = { ...armed, actPct: 0.95, hardPct: 0.99, cooldownMinutes: 60, handoffTimeoutMinutes: 60, idleFlushTokens: 900_000, idleMinutes: 60, heavyJobDeferMaxMinutes: 120 }
    expect(contextGuardWeakenings(armed, up).sort()).toEqual(['actPct', 'cooldownMinutes', 'handoffTimeoutMinutes', 'hardPct', 'heavyJobDeferMaxMinutes', 'idleFlushTokens', 'idleMinutes'])
    expect(contextGuardWeakenings(up, armed)).toEqual([])
  })
  it('limitTokens: only a smaller explicit number is not a weakening; clearing or raising it is', () => {
    expect(contextGuardWeakenings(armed, { ...armed, limitTokens: 300_000 })).toEqual([])
    expect(contextGuardWeakenings(armed, { ...armed, limitTokens: 900_000 })).toEqual(['limitTokens'])
    expect(contextGuardWeakenings(armed, { ...armed, limitTokens: null })).toEqual(['limitTokens'])
    expect(contextGuardWeakenings({ ...armed, limitTokens: null }, { ...armed, limitTokens: 300_000 })).toEqual(['limitTokens'])
  })
  it('dailyHandoffTime: setting it from null arms (not weakening); moving or clearing it is', () => {
    expect(contextGuardWeakenings({ ...armed, dailyHandoffTime: null }, armed)).toEqual([])
    expect(contextGuardWeakenings(armed, { ...armed, dailyHandoffTime: '23:00' })).toEqual(['dailyHandoffTime'])
    expect(contextGuardWeakenings(armed, { ...armed, dailyHandoffTime: null })).toEqual(['dailyHandoffTime'])
  })
  it('a reset to the shipped defaults over an armed guard is a weakening (the default enabled is false)', () => {
    expect(contextGuardWeakenings(armed, { ...CG_DEFAULT })).toContain('enabled')
  })
})

describe('OWNERGATE3-1104: PUT context-guard on the route', () => {
  const ARMED = { enabled: true, saturationRestart: true, actPct: 0.9, hardPct: 0.97, cooldownMinutes: 15 }
  const seed = (cfg: Record<string, unknown>) => {
    mkdirSync(STORE_ROOT, { recursive: true })
    writeFileSync(CONTEXT_GUARD_FILE, JSON.stringify({ [AGENT]: { ...CG_DEFAULT, ...cfg } }, null, 2))
  }
  const fileNow = () => readFileSync(CONTEXT_GUARD_FILE, 'utf-8')
  const put = (auth: Auth, body: unknown, headers: Record<string, string> = {}) => hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}/context-guard`, auth, body, headers)

  for (const [label, body, field] of [
    ['enabled off', { enabled: false }, 'enabled'],
    ['saturationRestart off', { saturationRestart: false }, 'saturationRestart'],
    ['actPct raised', { actPct: 0.95 }, 'actPct'],
    ['cooldown raised', { cooldownMinutes: 600 }, 'cooldownMinutes'],
  ] as const) {
    it(`bare token, weakening (${label}): 403, the field is named, the store is byte for byte unchanged`, async () => {
      seed(ARMED)
      const before = fileNow()
      const r = await put(TOKEN, body)
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(r.body.fields).toContain(field)
      expect(fileNow()).toBe(before)
    })
  }
  it('bare token, the arming skill shape (enabled on, the shipped defaults): 200 and written', async () => {
    seed({ enabled: false })
    const r = await put(TOKEN, { enabled: true, actPct: CG_DEFAULT.actPct, hardPct: CG_DEFAULT.hardPct, cooldownMinutes: CG_DEFAULT.cooldownMinutes })
    expect(r.status).toBe(200)
    const stored = JSON.parse(fileNow())[AGENT]
    expect(stored.enabled).toBe(true)
    expect(stored.actPct).toBe(CG_DEFAULT.actPct)
  })
  it('bare token, a non-default "stronger" value (actPct lowered to 0.85): 403, unchanged (review, Dani 69657)', async () => {
    seed({ enabled: false })
    const before = fileNow()
    const r = await put(TOKEN, { enabled: true, actPct: 0.85 })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(r.body.fields).toEqual(['actPct'])
    expect(fileNow()).toBe(before)
  })
  it('bare token, the same values again (no change): not refused', async () => {
    seed(ARMED)
    expect(refusedByOwnerGate(await put(TOKEN, { enabled: true }))).toBe(false)
  })
  it('the owner (session, or token + owner cookie) may weaken: 200 and written', async () => {
    seed(ARMED)
    expect((await put(SESSION, { enabled: false })).status).toBe(200)
    expect(JSON.parse(fileNow())[AGENT].enabled).toBe(false)
    seed(ARMED)
    expect((await put(TOKEN, { saturationRestart: false }, ownerCookie())).status).toBe(200)
    expect(JSON.parse(fileNow())[AGENT].saturationRestart).toBe(false)
  })
  it('a sub-agent token with the owner cookie may not weaken', async () => {
    seed(ARMED)
    const before = fileNow()
    expect(refusedByOwnerGate(await put(SUBAGENT, { enabled: false }, ownerCookie()))).toBe(true)
    expect(fileNow()).toBe(before)
  })
  it('zero users: weakening with the bare token is 403 setup_required; strengthening still goes through', async () => {
    resetOwnersForTest()
    seed(ARMED)
    const before = fileNow()
    const r = await put(TOKEN, { enabled: false })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(r.body.setup_required).toBe(true)
    expect(fileNow()).toBe(before)
    seed({ enabled: false })
    expect((await put(TOKEN, { enabled: true })).status).toBe(200)
  })
})

// Review (Dani 69657): unbounded strengthening is an availability attack (continuous handoff and restart). With the
// token a switch may only turn on and any other field may only go back to its shipped default.
const { contextGuardTokenRefusals, CONTEXT_GUARD_FIELD_KIND } = await import('../context-guard.js')
const { MAIN_AGENT_ID: MAIN_ID } = await import('../config.js')
describe('OWNERGATE3-1104: the token may strengthen only up to the shipped defaults (Dani 69657)', () => {
  it('every DEFAULT_CONTEXT_GUARD key is classified (a new key cannot fall outside the gate silently)', () => {
    expect(Object.keys(CONTEXT_GUARD_FIELD_KIND).sort()).toEqual(Object.keys(CG_DEFAULT).sort())
  })
  it('pure: the extreme "stronger" values are refused for the token; switches on and defaults back are not', () => {
    const off = { ...CG_DEFAULT, enabled: false, idleFlushEnabled: false }
    const extreme = { ...off, enabled: true, saturationRestart: true, actPct: 0.01, hardPct: 0.01, cooldownMinutes: 0.01, handoffTimeoutMinutes: 0.01, idleMinutes: 0.01, idleFlushEnabled: true, idleFlushTokens: 10_000 }
    expect(contextGuardTokenRefusals(off, extreme).sort()).toEqual(['actPct', 'cooldownMinutes', 'handoffTimeoutMinutes', 'hardPct', 'idleFlushTokens', 'idleMinutes'])
    expect(contextGuardTokenRefusals(off, { ...off, enabled: true, idleFlushEnabled: true })).toEqual([])
    // A lowered threshold going BACK to the default is a weakening: the owner's.
    expect(contextGuardTokenRefusals({ ...CG_DEFAULT, actPct: 0.5 }, { ...CG_DEFAULT })).toEqual(['actPct'])
    // A raised wait going back to the default is a strengthening to the default: the token's.
    expect(contextGuardTokenRefusals({ ...CG_DEFAULT, cooldownMinutes: 120 }, { ...CG_DEFAULT })).toEqual([])
  })
  const EXTREME = { enabled: true, saturationRestart: true, actPct: 0.01, hardPct: 0.01, cooldownMinutes: 0.01, handoffTimeoutMinutes: 0.01, idleMinutes: 0.01, idleFlushEnabled: true, idleFlushTokens: 10_000 }
  for (const [who, target] of [['a peer agent', AGENT], ['the main agent', MAIN_ID]] as const) {
    it(`route, ${who}: the bare token with the extreme values is 403 and the store is byte for byte unchanged`, async () => {
      mkdirSync(STORE_ROOT, { recursive: true })
      writeFileSync(CONTEXT_GUARD_FILE, JSON.stringify({ [target]: { ...CG_DEFAULT, enabled: false } }, null, 2))
      const before = readFileSync(CONTEXT_GUARD_FILE, 'utf-8')
      const r = await hit(tryHandleAgents, 'PUT', `/api/agents/${target}/context-guard`, TOKEN, EXTREME)
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(readFileSync(CONTEXT_GUARD_FILE, 'utf-8')).toBe(before)
    })
  }
  it('route: the owner may set a non-default value (session): 200 and written', async () => {
    mkdirSync(STORE_ROOT, { recursive: true })
    writeFileSync(CONTEXT_GUARD_FILE, JSON.stringify({ [AGENT]: { ...CG_DEFAULT } }, null, 2))
    expect((await hit(tryHandleAgents, 'PUT', `/api/agents/${AGENT}/context-guard`, SESSION, { actPct: 0.8 })).status).toBe(200)
    expect(JSON.parse(readFileSync(CONTEXT_GUARD_FILE, 'utf-8'))[AGENT].actPct).toBe(0.8)
  })
})
