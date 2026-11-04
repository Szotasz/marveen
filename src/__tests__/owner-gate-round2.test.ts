// OWNERGATE2-1104: the second round of owner gates. The shared access token (every sub-agent can read it) must not
// add, change or remove a Claude plan, create or import an agent, rewrite an agent's team trust, set up or remove a
// channel, grant someone the right to message an agent (pairing approve, invites, Slack channel requests), read the
// live invite tokens, revoke an invite or deny a channel request (every channel-access write, tech lead decision),
// delete an agent, add a connector (`claude mcp add`) or assign one into an agent's .mcp.json. Those need the owner
// (mayActAsOwner; OWNERGATE4-1104 merged mayActAsOwnerStrict into it): the
// browser login, the token with the owner's session cookie, or the Bridge's full key with that cookie. Before the
// first dashboard login exists the bare token still passes ONLY agent create, channel setup and a channel's FIRST
// pairing approve (the customer first-run path, mayActAsOwnerOrFirstRun); every other gate refuses it then with setup_required
// (review finding, tech lead decision), measured here route by route. The connector routes that run code on the host
// (GitHub repo install/update/remove, external project paths, MCP catalog install) are gated the same way. Rotate and
// probe stay token-callable (the rotation heartbeat uses them). A refused call writes NOTHING, measured on the bytes.
//
// Side effects that would leave the process are mocked: the vault (no real secret store), the main/sub-agent
// restarts and the running check (no tmux), execFile (no `claude mcp add`), the usage probe (no network). store/claude-plans*.json of this checkout are saved and
// restored (the agent-model-custom-provider-brackets.test.ts pattern).
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  restartMainForRotationContinue: vi.fn(async () => ({ ok: true, mode: 'continue' })),
}))
const restartAgentProcess = vi.fn(async () => ({ ok: true, pid: 1 }))
const stopAgentProcess = vi.fn(async () => ({ ok: true }))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  restartAgentProcess: () => restartAgentProcess(),
  // The agent DELETE asks whether a tmux session runs: answered here, no tmux is touched.
  isAgentRunning: () => false,
  stopAgentProcess: () => stopAgentProcess(),
}))
// POST /api/connectors runs `claude mcp add` through execFile: it must NEVER spawn here. The mock records the call and
// fails it, so a call that slipped through is both counted and harmless.
const execFileMock = vi.fn((...args: unknown[]) => {
  const cb = args.find((a) => typeof a === 'function') as ((e: Error) => void) | undefined
  cb?.(new Error('execFile is mocked in owner-gate-round2.test.ts'))
  return { stdin: { end() {} } }
})
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...a: unknown[]) => execFileMock(...a),
}))
// Rotation on, main agent NOT isolated: a rotate to a registered plan for the main agent stops at the 409
// "not applicable" check, before any write or restart.
vi.mock('../settings-store.js', async (orig) => {
  const real = await orig<typeof import('../settings-store.js')>()
  return {
    ...real,
    getEffectiveSettingValue: (key: string, ...rest: unknown[]) => {
      if (key === 'CLAUDE_ROTATION_ENABLED') return '1'
      if (key === 'MAIN_AGENT_ISOLATED_CONFIG') return '0'
      if (key === 'CLAUDE_ROTATION_FLEET') return '0'
      return (real.getEffectiveSettingValue as (...a: unknown[]) => unknown)(key, ...rest)
    },
  }
})
// OWNERGATE2-1104: the connector routes that clone, install or register code on the host. The helpers are mocked:
// a call that slipped past the gate is counted, never run (no git, no npm, no settings-file write).
const installGitHubRepo = vi.fn(async () => ({ repo: { name: 'og2repo' } }))
const removeGitHubRepo = vi.fn(() => ({ ok: true }))
const updateGitHubRepo = vi.fn(() => ({ ok: true }))
const addExternalProjectPath = vi.fn(() => ({ paths: ['/og2'] }))
const removeExternalProjectPath = vi.fn(() => [] as string[])
vi.mock('../web/dashboard-settings.js', async (orig) => ({
  ...(await orig<typeof import('../web/dashboard-settings.js')>()),
  installGitHubRepo: (...a: unknown[]) => (installGitHubRepo as any)(...a),
  removeGitHubRepo: (...a: unknown[]) => (removeGitHubRepo as any)(...a),
  updateGitHubRepo: (...a: unknown[]) => (updateGitHubRepo as any)(...a),
  addExternalProjectPath: (...a: unknown[]) => (addExternalProjectPath as any)(...a),
  removeExternalProjectPath: (...a: unknown[]) => (removeExternalProjectPath as any)(...a),
  getExternalProjectPaths: () => ['/og2'],
  getGitHubRepos: () => [],
}))
const probePlanUsage = vi.fn(async () => ({ ok: false as const, error: 'network' as const, message: 'mocked' }))
vi.mock('../claude-plan-usage-probe.js', async (orig) => ({
  ...(await orig<typeof import('../claude-plan-usage-probe.js')>()),
  probePlanUsage: () => probePlanUsage(),
}))

const { initDatabase, getDb, createDashboardUser, upsertChannelRequest, listPendingChannelRequests } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { tryHandleClaudePlans } = await import('../web/routes/claude-plans.js')
const { tryHandleConnectors } = await import('../web/routes/connectors.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')
const { CLAUDE_PLANS_PATH, writeClaudePlans, tokenSecretIdFor } = await import('../web/claude-plans.js')
const { CLAUDE_PLANS_STATE_PATH } = await import('../web/claude-plans-state.js')
const { logger } = await import('../logger.js')

const AGENT = '__test-og2-agent'
const PEER = '__test-og2-peer'
const DIR = agentDir(AGENT)
const PEER_DIR = agentDir(PEER)
const TG_DIR = join(DIR, '.claude', 'channels', 'telegram')
const SLACK_DIR = join(DIR, '.claude', 'channels', 'slack')
const CONN = '__og2-test-connector'

type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; device?: string; tokenAgent?: string } | undefined
type Handler = (ctx: any, webDir: string) => Promise<boolean>
async function hit(handler: Handler, method: string, path: string, auth: Auth, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]
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

// --- fixtures ---------------------------------------------------------------------------------------------------
const PLAN_CFG = { id: 'og2cfg', label: 'OG2 config plan', configDir: '~/.og2-test-plan-dir', planType: 'personal', channelsAllowed: true }
const PLAN_TOK = { id: 'og2tok', label: 'OG2 token plan', tokenSecretId: tokenSecretIdFor('og2tok'), planType: 'personal', channelsAllowed: true }
const ACCESS = { dmPolicy: 'allowlist', allowFrom: ['111'], groups: { g1: { requireMention: true } }, pending: { ABC123: { senderId: '222', chatId: '222' } } }
const INVITES = { invites: { livetoken000000000000a: { createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, used: false } } }

let plansBefore: string | null = null
const AGENTS_ROOT = join(PROJECT_ROOT, 'agents')
const agentsRootExisted = existsSync(AGENTS_ROOT)
const STORE_ROOT = join(PROJECT_ROOT, 'store')
const storeRootExisted = existsSync(STORE_ROOT)
let stateBefore: string | null = null

function seedAgents() {
  for (const d of [DIR, PEER_DIR]) rmSync(d, { recursive: true, force: true })
  mkdirSync(TG_DIR, { recursive: true })
  mkdirSync(SLACK_DIR, { recursive: true })
  mkdirSync(PEER_DIR, { recursive: true })
  writeFileSync(join(DIR, 'CLAUDE.md'), '# og2\n')
  writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify({ model: 'claude-opus-5', team: { role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [] } }, null, 2))
  writeFileSync(join(DIR, '.mcp.json'), '{"mcpServers":{}}\n')
  writeFileSync(join(PEER_DIR, 'CLAUDE.md'), '# peer\n')
  writeFileSync(join(PEER_DIR, '.mcp.json'), JSON.stringify({ mcpServers: { [CONN]: { command: 'true' } } }))
  writeFileSync(join(TG_DIR, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n')
  writeFileSync(join(TG_DIR, 'access.json'), JSON.stringify(ACCESS, null, 2))
  writeFileSync(join(TG_DIR, 'invites.json'), JSON.stringify(INVITES, null, 2))
  writeFileSync(join(SLACK_DIR, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: {} }, null, 2))
}
const agentFiles = () => Object.fromEntries([
  join(DIR, 'agent-config.json'), join(DIR, '.mcp.json'), join(TG_DIR, '.env'), join(TG_DIR, 'access.json'),
  join(TG_DIR, 'invites.json'), join(SLACK_DIR, 'access.json'), join(SLACK_DIR, 'invites.json'),
].map((p) => [p, read(p)]))
const planFiles = () => ({ plans: read(CLAUDE_PLANS_PATH), state: read(CLAUDE_PLANS_STATE_PATH) })

beforeAll(() => {
  initDatabase(':memory:')
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  plansBefore = read(CLAUDE_PLANS_PATH)
  stateBefore = read(CLAUDE_PLANS_STATE_PATH)
})
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM pending_channel_requests')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  seedAgents()
  writeClaudePlans([PLAN_CFG, PLAN_TOK] as any)
  rmSync(CLAUDE_PLANS_STATE_PATH, { force: true })
  vaultSecrets.clear()
  vaultSecrets.set(PLAN_TOK.tokenSecretId, 'sk-ant-oat01-og2-test')
  hardRestartMarveenChannels.mockClear()
  restartAgentProcess.mockClear()
  probePlanUsage.mockClear()
  execFileMock.mockClear()
  stopAgentProcess.mockClear()
  for (const m of [installGitHubRepo, removeGitHubRepo, updateGitHubRepo, addExternalProjectPath, removeExternalProjectPath]) m.mockClear()
})
afterAll(() => {
  for (const d of [DIR, PEER_DIR]) rmSync(d, { recursive: true, force: true })
  if (!agentsRootExisted && existsSync(AGENTS_ROOT) && readdirSync(AGENTS_ROOT).length === 0) rmSync(AGENTS_ROOT, { recursive: true })
  if (plansBefore !== null) writeFileSync(CLAUDE_PLANS_PATH, plansBefore)
  else rmSync(CLAUDE_PLANS_PATH, { force: true })
  if (stateBefore !== null) writeFileSync(CLAUDE_PLANS_STATE_PATH, stateBefore)
  else rmSync(CLAUDE_PLANS_STATE_PATH, { force: true })
  if (!storeRootExisted && existsSync(STORE_ROOT) && readdirSync(STORE_ROOT).length === 0) rmSync(STORE_ROOT, { recursive: true })
})

// --- the gated routes -------------------------------------------------------------------------------------------
type Case = {
  label: string
  // OWNERGATE2-1104: true only for the routes that keep the first-run branch (agent create, channel setup). Every other
  // case is refused before the first login too, with setup_required.
  firstRunOpen?: true
  handler: Handler
  method: string
  path: () => string
  body?: unknown
  snapshot: () => unknown
  // An owner-lane call: either the write is measured, or (when that would need a CLI/network) only "not the owner gate".
  ownerCheck?: (r: { status: number; body: any }) => void
}
const CASES: Case[] = [
  {
    label: 'POST /api/claude-plans', handler: tryHandleClaudePlans, method: 'POST', path: () => '/api/claude-plans',
    body: { id: 'og2new', label: 'New', configDir: '~/.og2-new-plan-dir', planType: 'team', channelsAllowed: false },
    snapshot: planFiles,
    ownerCheck: (r) => { expect(r.status).toBe(201); expect(read(CLAUDE_PLANS_PATH)).toContain('og2new') },
  },
  {
    label: 'PUT /api/claude-plans/:id', handler: tryHandleClaudePlans, method: 'PUT', path: () => `/api/claude-plans/${PLAN_CFG.id}`,
    body: { ...PLAN_CFG, label: 'Renamed by caller' },
    snapshot: planFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(read(CLAUDE_PLANS_PATH)).toContain('Renamed by caller') },
  },
  {
    label: 'DELETE /api/claude-plans/:id', handler: tryHandleClaudePlans, method: 'DELETE', path: () => `/api/claude-plans/${PLAN_CFG.id}`,
    snapshot: planFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(read(CLAUDE_PLANS_PATH)).not.toContain(PLAN_CFG.id) },
  },
  {
    // A body that stops at the name check right after the gate: rawModel is given (no CLI probe for the default),
    // no name -> 400 before the CLI gate and the scaffold.
    firstRunOpen: true, label: 'POST /api/agents', handler: tryHandleAgents, method: 'POST', path: () => '/api/agents',
    body: { model: 'claude-opus-5', description: 'x' },
    snapshot: () => ({ ...agentFiles(), exists: existsSync(join(PROJECT_ROOT, 'agents')) }),
    ownerCheck: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('Name is required') },
  },
  {
    label: 'POST /api/agents/import (no overwrite)', handler: tryHandleAgents, method: 'POST', path: () => '/api/agents/import',
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('No bundle uploaded') },
  },
  {
    label: 'PUT /api/agents/:name/team', handler: tryHandleAgents, method: 'PUT', path: () => `/api/agents/${AGENT}/team`,
    body: { trustFrom: [PEER], reportsTo: PEER },
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(JSON.parse(read(join(DIR, 'agent-config.json'))!).team.trustFrom).toEqual([PEER]) },
  },
  {
    // botToken missing -> 400 before any network token check.
    firstRunOpen: true, label: 'POST /api/agents/:name/channels/telegram (setup)', handler: tryHandleAgents, method: 'POST', path: () => `/api/agents/${AGENT}/channels/telegram`,
    body: { allowFrom: ['999'] },
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('botToken is required') },
  },
  {
    firstRunOpen: true, label: 'POST /api/agents/:name/telegram (legacy setup)', handler: tryHandleAgents, method: 'POST', path: () => `/api/agents/${AGENT}/telegram`,
    body: { allowFrom: ['999'] },
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('botToken is required') },
  },
  {
    label: 'DELETE /api/agents/:name/channels/telegram', handler: tryHandleAgents, method: 'DELETE', path: () => `/api/agents/${AGENT}/channels/telegram`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(existsSync(join(TG_DIR, '.env'))).toBe(false); expect(existsSync(join(TG_DIR, 'access.json'))).toBe(false) },
  },
  {
    label: 'POST /api/agents/:name/channels/telegram/approve', handler: tryHandleAgents, method: 'POST', path: () => `/api/agents/${AGENT}/channels/telegram/approve`,
    body: { code: 'ABC123' },
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(JSON.parse(read(join(TG_DIR, 'access.json'))!).allowFrom).toContain('222') },
  },
  {
    label: 'POST /api/agents/:name/channels/slack/invites', handler: tryHandleAgents, method: 'POST', path: () => `/api/agents/${AGENT}/channels/slack/invites`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(typeof r.body.token).toBe('string'); expect(read(join(SLACK_DIR, 'invites.json'))).toContain(r.body.token) },
  },
  {
    label: 'GET /api/agents/:name/channels/telegram/invites', handler: tryHandleAgents, method: 'GET', path: () => `/api/agents/${AGENT}/channels/telegram/invites`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(JSON.stringify(r.body)).toContain('livetoken000000000000a') },
  },
  {
    label: 'GET /api/agents/:name/telegram/invites (legacy)', handler: tryHandleAgents, method: 'GET', path: () => `/api/agents/${AGENT}/telegram/invites`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200) },
  },
  {
    label: 'DELETE /api/agents/:name/channels/telegram/allowed/user/:id', handler: tryHandleAgents, method: 'DELETE', path: () => `/api/agents/${AGENT}/channels/telegram/allowed/user/111`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(JSON.parse(read(join(TG_DIR, 'access.json'))!).allowFrom).not.toContain('111') },
  },
  {
    label: 'DELETE /api/agents/:name/telegram/allowed/group/:id (legacy)', handler: tryHandleAgents, method: 'DELETE', path: () => `/api/agents/${AGENT}/telegram/allowed/group/g1`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(JSON.parse(read(join(TG_DIR, 'access.json'))!).groups.g1).toBeUndefined() },
  },
  {
    label: 'POST /api/agents/:name/channel-requests/:id/approve', handler: tryHandleAgents, method: 'POST',
    path: () => {
      writeFileSync(join(DIR, 'agent-config.json'), JSON.stringify({ ...JSON.parse(read(join(DIR, 'agent-config.json'))!), channelProvider: 'slack' }, null, 2))
      upsertChannelRequest(AGENT, 'C0OG2TEST', 'U0OG2')
      return `/api/agents/${AGENT}/channel-requests/${listPendingChannelRequests(AGENT)[0].id}/approve`
    },
    body: { allowFromAll: true },
    snapshot: () => ({ ...agentFiles(), pending: listPendingChannelRequests(AGENT).length }),
    ownerCheck: (r) => {
      expect(r.status).toBe(200)
      expect(JSON.parse(read(join(SLACK_DIR, 'access.json'))!).channels.C0OG2TEST).toBeTruthy()
      expect(listPendingChannelRequests(AGENT)).toHaveLength(0)
    },
  },
  {
    label: 'DELETE /api/agents/:name/channels/telegram/invites/:token', handler: tryHandleAgents, method: 'DELETE', path: () => `/api/agents/${AGENT}/channels/telegram/invites/livetoken000000000000a`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(read(join(TG_DIR, 'invites.json'))).not.toContain('livetoken000000000000a') },
  },
  {
    label: 'DELETE /api/agents/:name/telegram/invites/:token (legacy)', handler: tryHandleAgents, method: 'DELETE', path: () => `/api/agents/${AGENT}/telegram/invites/livetoken000000000000a`,
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200) },
  },
  {
    label: 'POST /api/agents/:name/channel-requests/:id/deny', handler: tryHandleAgents, method: 'POST',
    path: () => {
      upsertChannelRequest(AGENT, 'C0OG2DENY', 'U0OG2')
      return `/api/agents/${AGENT}/channel-requests/${listPendingChannelRequests(AGENT)[0].id}/deny`
    },
    snapshot: () => ({ ...agentFiles(), pending: listPendingChannelRequests(AGENT).length }),
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(listPendingChannelRequests(AGENT)).toHaveLength(0) },
  },
  {
    label: 'DELETE /api/agents/:name', handler: tryHandleAgents, method: 'DELETE', path: () => `/api/agents/${AGENT}`,
    snapshot: () => ({ ...agentFiles(), dir: existsSync(DIR), claudeMd: read(join(DIR, 'CLAUDE.md')) }),
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(existsSync(DIR)).toBe(false) },
  },
  {
    // stdio without a command: the owner lanes stop at validation right after the gate, before any spawn.
    label: 'POST /api/connectors', handler: tryHandleConnectors, method: 'POST', path: () => '/api/connectors',
    body: { name: 'og2conn', type: 'stdio' },
    snapshot: () => ({ ...agentFiles(), spawned: execFileMock.mock.calls.length }),
    ownerCheck: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('URL (http/sse) or command (stdio) required'); expect(execFileMock).not.toHaveBeenCalled() },
  },
  {
    label: 'POST /api/connectors/:name/assign', handler: tryHandleConnectors, method: 'POST', path: () => `/api/connectors/${CONN}/assign`,
    body: { agents: [AGENT] },
    snapshot: agentFiles,
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(JSON.parse(read(join(DIR, '.mcp.json'))!).mcpServers[CONN]).toEqual({ command: 'true' }) },
  },
  // OWNERGATE2-1104, the new gates: the snapshot counts the mocked helper calls (and the vault writes), so a refused
  // call that reached the clone, the npm install, the settings write or `claude mcp add` shows up as a changed snapshot.
  {
    label: 'POST /api/connectors/github-repos', handler: tryHandleConnectors, method: 'POST', path: () => '/api/connectors/github-repos',
    body: { url: 'https://github.com/og2/og2repo', env: { OG2_KEY: 'v' }, runScripts: true },
    snapshot: () => ({ install: installGitHubRepo.mock.calls.length, vault: vaultSecrets.size, spawned: execFileMock.mock.calls.length }),
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(installGitHubRepo).toHaveBeenCalledTimes(1) },
  },
  {
    label: 'DELETE /api/connectors/github-repos/:name', handler: tryHandleConnectors, method: 'DELETE', path: () => '/api/connectors/github-repos/og2repo',
    snapshot: () => ({ remove: removeGitHubRepo.mock.calls.length }),
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(removeGitHubRepo).toHaveBeenCalledWith('og2repo') },
  },
  {
    label: 'PATCH /api/connectors/github-repos/:name', handler: tryHandleConnectors, method: 'PATCH', path: () => '/api/connectors/github-repos/og2repo',
    body: { runScripts: true },
    snapshot: () => ({ update: updateGitHubRepo.mock.calls.length }),
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(updateGitHubRepo).toHaveBeenCalledTimes(1) },
  },
  {
    label: 'POST /api/connectors/external-paths', handler: tryHandleConnectors, method: 'POST', path: () => '/api/connectors/external-paths',
    body: { path: '/og2' },
    snapshot: () => ({ add: addExternalProjectPath.mock.calls.length }),
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(addExternalProjectPath).toHaveBeenCalledWith('/og2') },
  },
  {
    label: 'DELETE /api/connectors/external-paths', handler: tryHandleConnectors, method: 'DELETE', path: () => '/api/connectors/external-paths',
    body: { path: '/og2' },
    snapshot: () => ({ remove: removeExternalProjectPath.mock.calls.length }),
    ownerCheck: (r) => { expect(r.status).toBe(200); expect(removeExternalProjectPath).toHaveBeenCalledWith('/og2') },
  },
  {
    // The gate runs before the catalog lookup, so an id that is not in the catalog measures it without reaching
    // `claude mcp add`: the owner lanes get the 404 that follows the gate. A real id with the bare token is below.
    label: 'POST /api/mcp-catalog/:id/install', handler: tryHandleConnectors, method: 'POST', path: () => '/api/mcp-catalog/og2-not-in-catalog/install',
    body: {},
    snapshot: () => ({ spawned: execFileMock.mock.calls.length }),
    ownerCheck: (r) => { expect(r.status).toBe(404); expect(execFileMock).not.toHaveBeenCalled() },
  },
]

describe('OWNERGATE2-1104: the bare shared token is refused and nothing changes', () => {
  for (const c of CASES) {
    it(c.label, async () => {
      const path = c.path()
      const before = c.snapshot()
      const r = await hit(c.handler, c.method, path, TOKEN, c.body)
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(typeof r.body.error).toBe('string')
      expect(c.snapshot()).toEqual(before)
    })
  }
})

describe('OWNERGATE2-1104: the owner lanes pass the gate (and the write happens)', () => {
  for (const c of CASES) {
    for (const [lane, auth, headers] of OWNER_LANES) {
      it(`${c.label}: ${lane}`, async () => {
        const path = c.path()
        const r = await hit(c.handler, c.method, path, auth, c.body, headers())
        expect(refusedByOwnerGate(r)).toBe(false)
        c.ownerCheck?.(r)
      })
    }
  }
})

describe('OWNERGATE2-1104: the non-owner lanes are refused', () => {
  for (const c of CASES) {
    for (const [lane, auth, headers] of NON_OWNER) {
      it(`${c.label}: ${lane}`, async () => {
        const path = c.path()
        const before = c.snapshot()
        const r = await hit(c.handler, c.method, path, auth, c.body, headers())
        expect(refusedByOwnerGate(r)).toBe(true)
        expect(c.snapshot()).toEqual(before)
      })
    }
  }
})

describe('OWNERGATE2-1104: the main agent shares the channel handlers, and the gate', () => {
  it('GET invites and POST approve for the main agent refuse the bare token', async () => {
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'GET', `/api/agents/${MAIN_AGENT_ID}/channels/telegram/invites`, TOKEN))).toBe(true)
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'POST', `/api/agents/${MAIN_AGENT_ID}/channels/telegram/approve`, TOKEN, { code: 'X' }))).toBe(true)
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'POST', `/api/agents/${MAIN_AGENT_ID}/channels/telegram`, TOKEN, {}))).toBe(true)
  })
})

describe('OWNERGATE2-1104: first-run (zero dashboard users), every gated route', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
  })
  for (const c of CASES) {
    it(`${c.label}: ${c.firstRunOpen ? 'the bare token passes the owner gate (first-run branch)' : '403 setup_required, nothing changes'}`, async () => {
      const path = c.path()
      const before = c.snapshot()
      const r = await hit(c.handler, c.method, path, TOKEN, c.body)
      if (c.firstRunOpen) {
        expect(refusedByOwnerGate(r)).toBe(false)
        return
      }
      expect(refusedByOwnerGate(r)).toBe(true)
      expect(r.body.setup_required).toBe(true)
      expect(r.body.error).toMatch(/no dashboard login exists yet/)
      expect(c.snapshot()).toEqual(before)
    })
  }
  it('with a dashboard login present the refusal carries no setup_required and keeps the route text (control)', async () => {
    createDashboardUser('owner2', 'x'.repeat(60))
    const r = await hit(tryHandleAgents, 'DELETE', `/api/agents/${AGENT}`, TOKEN)
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(r.body.setup_required).toBeUndefined()
    expect(r.body.error).toBe('Deleting an agent needs the dashboard login (an owner session).')
  })
})

describe('OWNERGATE2-1104: pairing approve keeps the first-run branch for a channel\'s FIRST pairing only', () => {
  const accessPath = join(TG_DIR, 'access.json')
  const seedFirstPairing = () => {
    writeFileSync(accessPath, JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: { FIRST1: { senderId: '501', chatId: '501' } } }, null, 2))
    rmSync(join(TG_DIR, 'approved'), { recursive: true, force: true })
  }
  const zeroUsers = () => { getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users'); _clearSessionCacheForTest() }
  for (const route of ['channels/telegram/approve', 'telegram/approve']) {
    it(`${route}: zero users, the first approve passes with the bare token; the second is 403 setup_required and access.json is unchanged`, async () => {
      zeroUsers()
      seedFirstPairing()
      const first = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/${route}`, TOKEN, { code: 'FIRST1' })
      expect(refusedByOwnerGate(first)).toBe(false)
      expect(first.status).toBe(200)
      expect(JSON.parse(read(accessPath)!).allowFrom).toEqual(['501'])
      expect(existsSync(join(TG_DIR, 'approved', '501'))).toBe(true)
      // A second sender asks to pair: the channel already has its owner, so the token is no longer enough.
      const access = JSON.parse(read(accessPath)!)
      access.pending = { SECOND: { senderId: '666', chatId: '666' } }
      writeFileSync(accessPath, JSON.stringify(access, null, 2))
      const before = read(accessPath)
      const second = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/${route}`, TOKEN, { code: 'SECOND' })
      expect(refusedByOwnerGate(second)).toBe(true)
      expect(second.body.setup_required).toBe(true)
      expect(read(accessPath)).toBe(before)
      expect(existsSync(join(TG_DIR, 'approved', '666'))).toBe(false)
    })
  }
  it('zero users: an approved/ marker alone (allowFrom empty) still counts as an owner', async () => {
    zeroUsers()
    seedFirstPairing()
    mkdirSync(join(TG_DIR, 'approved'), { recursive: true })
    writeFileSync(join(TG_DIR, 'approved', '501'), '501')
    const before = read(accessPath)
    const r = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/channels/telegram/approve`, TOKEN, { code: 'FIRST1' })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(r.body.setup_required).toBe(true)
    expect(read(accessPath)).toBe(before)
  })
  it('zero users: an unreadable access.json counts as having an owner (fail closed)', async () => {
    zeroUsers()
    writeFileSync(accessPath, '{not json')
    const r = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/channels/telegram/approve`, TOKEN, { code: 'X' })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(read(accessPath)).toBe('{not json')
  })
  it('zero users: a sub-agent token is refused even on the first pairing', async () => {
    zeroUsers()
    seedFirstPairing()
    const before = read(accessPath)
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/channels/telegram/approve`, SUBAGENT, { code: 'FIRST1' }))).toBe(true)
    expect(read(accessPath)).toBe(before)
  })
  it('a dashboard login exists: the first pairing is strict too (bare token 403, no setup_required); the owner cookie passes', async () => {
    seedFirstPairing()
    const before = read(accessPath)
    const r = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/channels/telegram/approve`, TOKEN, { code: 'FIRST1' })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(r.body.setup_required).toBeUndefined()
    expect(read(accessPath)).toBe(before)
    const ok = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/channels/telegram/approve`, TOKEN, { code: 'FIRST1' }, ownerCookie())
    expect(ok.status).toBe(200)
  })
})

describe('OWNERGATE2-1104: first-run branch details (zero dashboard users)', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
  })
  it('POST /api/agents: the bare token passes the gate and stops at validation', async () => {
    const r = await hit(tryHandleAgents, 'POST', '/api/agents', TOKEN, { model: 'claude-opus-5', description: 'x' })
    expect(refusedByOwnerGate(r)).toBe(false)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Name is required')
  })
  it('channel setup POST: the bare token passes the gate and stops at validation', async () => {
    const r = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/channels/slack`, TOKEN, {})
    expect(refusedByOwnerGate(r)).toBe(false)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('botToken is required')
  })
  it('a sub-agent token is still refused before the first login', async () => {
    expect(refusedByOwnerGate(await hit(tryHandleAgents, 'POST', '/api/agents', SUBAGENT, { model: 'claude-opus-5' }))).toBe(true)
  })
})

describe('controls: what stays token-callable', () => {
  it('rotate to an unregistered plan id is 400, a raw configDir in the body is ignored, nothing written', async () => {
    const before = planFiles()
    const r = await hit(tryHandleClaudePlans, 'POST', '/api/claude-plans/rotate', TOKEN, { targetPlanId: 'og2-not-registered', configDir: '/tmp/og2-evil' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Unknown target plan id: og2-not-registered')
    expect(planFiles()).toEqual(before)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
    expect(restartAgentProcess).not.toHaveBeenCalled()
  })
  it('rotate with the bare token to a registered plan is not refused by the owner gate (stops at the isolation check)', async () => {
    const before = planFiles()
    const r = await hit(tryHandleClaudePlans, 'POST', '/api/claude-plans/rotate', TOKEN, { targetPlanId: PLAN_CFG.id })
    expect(refusedByOwnerGate(r)).toBe(false)
    expect(r.status).toBe(409)
    expect(planFiles()).toEqual(before)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })
  it('probe with the bare token is not refused by the owner gate, and logs the plan id with the caller kind', async () => {
    const info = vi.spyOn(logger, 'info')
    const r = await hit(tryHandleClaudePlans, 'POST', `/api/claude-plans/${PLAN_TOK.id}/probe`, TOKEN)
    expect(refusedByOwnerGate(r)).toBe(false)
    expect(probePlanUsage).toHaveBeenCalledTimes(1)
    expect(r.status).toBe(502)
    const line = info.mock.calls.find((c) => c[1] === 'Claude plan usage probed')
    expect(line?.[0]).toMatchObject({ id: PLAN_TOK.id, caller: 'token' })
    expect(JSON.stringify(line?.[0])).not.toContain('sk-ant')
    // A second probe inside the window is throttled (429), no second network call.
    const again = await hit(tryHandleClaudePlans, 'POST', `/api/claude-plans/${PLAN_TOK.id}/probe`, TOKEN)
    expect(again.status).toBe(429)
    expect(probePlanUsage).toHaveBeenCalledTimes(1)
    info.mockRestore()
  })
  it('probe of a config-dir plan is 422 (no network), not the owner gate', async () => {
    const r = await hit(tryHandleClaudePlans, 'POST', `/api/claude-plans/${PLAN_CFG.id}/probe`, TOKEN)
    expect(r.status).toBe(422)
    expect(probePlanUsage).not.toHaveBeenCalled()
  })
  it('GET routes listed as open stay open for the bare token', async () => {
    for (const p of ['/api/claude-plans', '/api/claude-plans/state']) {
      expect((await hit(tryHandleClaudePlans, 'GET', p, TOKEN)).status).toBe(200)
    }
    for (const p of [
      `/api/agents/${AGENT}/team`,
      `/api/agents/${AGENT}/channels/telegram/pending`,
      `/api/agents/${AGENT}/channels/telegram/allowed`,
      `/api/agents/${AGENT}/channel-requests`,
    ]) {
      const r = await hit(tryHandleAgents, 'GET', p, TOKEN)
      expect(r.status, p).toBe(200)
    }
  })
  it('the GETs beside the new connector gates stay open for the bare token', async () => {
    expect((await hit(tryHandleConnectors, 'GET', '/api/connectors/external-paths', TOKEN)).status).toBe(200)
    expect((await hit(tryHandleConnectors, 'GET', '/api/connectors/github-repos', TOKEN)).status).toBe(200)
    expect((await hit(tryHandleConnectors, 'GET', '/api/mcp-catalog', TOKEN)).status).toBe(200)
  })
  it('POST /api/connectors/github-repos with the bare token: no clone, no npm, no vault write (OWNERGATE2-1104)', async () => {
    const r = await hit(tryHandleConnectors, 'POST', '/api/connectors/github-repos', TOKEN, { url: 'https://github.com/og2/og2repo', env: { OG2_KEY: 'v' }, runScripts: true })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(installGitHubRepo).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
    expect([...vaultSecrets.keys()].some((k) => k.startsWith('github-env-'))).toBe(false)
  })
  it('POST /api/mcp-catalog/:id/install of a real catalog item with the bare token: refused, `claude mcp add` never spawned', async () => {
    for (const id of ['notion', 'filesystem']) {
      const r = await hit(tryHandleConnectors, 'POST', `/api/mcp-catalog/${id}/install`, TOKEN, {})
      expect(refusedByOwnerGate(r), id).toBe(true)
    }
    expect(execFileMock).not.toHaveBeenCalled()
  })
  it('POST /api/connectors with a full stdio body and the bare token: refused, and `claude mcp add` is never spawned', async () => {
    const r = await hit(tryHandleConnectors, 'POST', '/api/connectors', TOKEN, { name: 'og2conn', type: 'stdio', command: 'touch', args: '/tmp/og2-should-not-exist' })
    expect(refusedByOwnerGate(r)).toBe(true)
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
