// OWNERGATE4-1104 (tech lead decision): mayActAsOwner is strict, and the first-run setup (the bare SHARED token as the
// owner while no dashboard login exists) is a closed list, mayActAsOwnerOrFirstRun with a reason from FIRST_RUN_PATHS.
// Measured here on the real route handlers with zero dashboard users:
//   - every FIRST_RUN_PATHS route lets the bare token past the owner gate (it then stops at its own validation);
//   - a representative set of every other formerly-loose route refuses it with 403 owner_session_required +
//     setup_required: true, and the state it would write is unchanged;
//   - 'first-device' (Bridge enrolment, key mint) only while no device key was EVER issued (a revoked one counts);
//   - 'first-login' (POST /api/auth/users) only with zero users; a full device key may create the first login too;
//   - a sub-agent token never passes any first-run path.
// Side effects that would leave the process are mocked; PROJECT_ROOT/STORE_DIR point at a throwaway directory.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const T = vi.hoisted(() => ({ root: '' }))
// The throwaway root is made by the node:os mock (the first factory to run: the config mock imports node:os).
vi.mock('../config.js', async (orig) => {
  await import('node:os')
  const { join: j } = await import('node:path')
  return { ...(await orig<typeof import('../config.js')>()), PROJECT_ROOT: T.root, STORE_DIR: j(T.root, 'store'), MAIN_AGENT_ID: 'og4-main', TELEGRAM_BOT_TOKEN: '' }
})
// The home dir is the throwaway root's home/: onboarding reads ~/.claude/.credentials.json and the main agent's
// legacy channel dir sits under ~/.claude/channels; neither may be the host's.
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const { mkdtempSync: mk } = await import('node:fs')
  const { join: j } = await import('node:path')
  if (!T.root) T.root = mk(j(a.tmpdir(), 'og4-first-run-'))
  const homedir = () => `${T.root}/home`
  return { ...a, homedir, default: { ...a, homedir } }
})
vi.mock('../web/telegram.js', async (orig) => ({ ...(await orig<typeof import('../web/telegram.js')>()), sendTelegramMessage: vi.fn(async () => null) }))
vi.mock('../web/vault.js', async (orig) => ({
  ...(await orig<typeof import('../web/vault.js')>()),
  setSecret: vi.fn(), deleteSecret: vi.fn(), getSecret: vi.fn(() => null),
}))
// The claude-auth route live-probes a token with a real `claude -p` once past its gate. Never from a test: a probe
// that proves the token dead, so even a gate regression persists nothing.
vi.mock('../web/claude-credentials-guard.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-credentials-guard.js')>()),
  liveProbeAuth: vi.fn(async () => 'auth-rejected' as const),
}))
vi.mock('../web/channel-monitor.js', async (orig) => ({
  ...(await orig<typeof import('../web/channel-monitor.js')>()),
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  restartAgentProcess: vi.fn(async () => ({ ok: true, pid: 1 })),
  stopAgentProcess: vi.fn(async () => ({ ok: true })),
  startAgentProcess: vi.fn(async () => ({ ok: true })),
  isAgentRunning: () => false,
  // claudeAuthPresent's last leg asks tmux about the running channels session: never the host's tmux here.
  sessionExistsOnHost: () => false,
}))
const h = vi.hoisted(() => ({
  imports: 0, exports: 0, operatorWrites: 0, unfreezes: 0, settingWrites: 0,
}))
vi.mock('../web/fleet-transfer.js', async (orig) => ({
  ...(await orig<typeof import('../web/fleet-transfer.js')>()),
  importFleet: () => { h.imports++; return { applied: true, warnings: [] } },
  exportFleet: () => { h.exports++; return { data: '{}', exportedAt: '2026-11-04T00:00:00.000Z' } },
}))
vi.mock('../web/operator-access.js', async (orig) => ({
  ...(await orig<typeof import('../web/operator-access.js')>()),
  writeOperatorAccess: () => { h.operatorWrites++ },
}))
vi.mock('../web/fleet-freeze.js', async (orig) => ({
  ...(await orig<typeof import('../web/fleet-freeze.js')>()),
  clearFleetFreeze: () => { h.unfreezes++; return null },
}))
// BRIDGEFIRSTLOGIN1106: the owner's security notices, recorded instead of sent
const notices = vi.hoisted(() => [] as string[])
vi.mock('../notify.js', async (orig) => ({
  ...(await orig<typeof import('../notify.js')>()),
  notifySecurityEvent: async (text: string) => { notices.push(text) },
}))
const settings = vi.hoisted(() => new Map<string, string>())
vi.mock('../settings-store.js', async (orig) => ({
  ...(await orig<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? '',
  setOverride: (k: string, v: unknown) => { h.settingWrites++; settings.set(k, String(v)); return { ok: true } },
  clearOverride: (k: string) => { h.settingWrites++; return { ok: true, removed: settings.delete(k) } },
}))

const { initDatabase, createDashboardUser, getDashboardUser, listDashboardUsers, getApproval } = await import('../db.js')
const { _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { createDeviceKey, revokeDeviceKey, listDeviceKeys, deviceKeyEverIssued, _clearDeviceKeyCacheForTest } = await import('../web/auth-device-keys.js')
const { tryHandleAuth, mayActAsOwner, mayActAsOwnerOrFirstRun, FIRST_RUN_PATHS } = await import('../web/routes/auth.js')
const { tryHandleSecurity } = await import('../web/routes/security.js')
const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')
const { tryHandleClaudePlansLogin } = await import('../web/routes/claude-plans-login.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { tryHandleApprovals } = await import('../web/routes/approvals.js')
const { tryHandleAutonomy } = await import('../web/routes/autonomy.js')
const { tryHandleSettings } = await import('../web/routes/settings.js')
const { tryHandleSkills } = await import('../web/routes/skills.js')
const { tryHandleFleet } = await import('../web/routes/fleet.js')
const { tryHandleFleetFreeze } = await import('../web/routes/fleet-freeze.js')
const { tryHandleOperatorAccess } = await import('../web/routes/operator-access.js')
const { tryHandleFederation } = await import('../web/routes/federation.js')
const { _setFederationStoreDirForTest, reloadFederationForTest, getFederationConfig } = await import('../web/federation/config.js')
const { logger } = await import('../logger.js')
const { CLI_VERSION_OVERRIDE_ENV } = await import('../web/claude-cli-version.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

afterAll(() => { rmSync(T.root, { recursive: true, force: true }) })

const TOKEN: Auth = { kind: 'token' }
const SUBAGENT: Auth = { kind: 'token', agent: 'samu', tokenAgent: 'samu' }
const SESSION: Auth = { kind: 'session', user: 'owner' }
const FULL_KEY: Auth = { kind: 'device', device: 'Bridge', deviceId: 1, scope: 'full' }
const OPERATOR_KEY: Auth = { kind: 'device', device: 'Op', deviceId: 2, scope: 'operator' }
const AGENT = 'og4agent'
const AGENT_DIR = join(T.root, 'agents', AGENT)
const TG_DIR = join(AGENT_DIR, '.claude', 'channels', 'telegram')
const AUTONOMY = join(T.root, 'store', 'autonomy-config.json')
const AUTONOMY_DOC = JSON.stringify({ version: 1, updated_at: 0, categories: [{ key: 'email_send', label: 'Email', level: 2, locked: false, maxLevel: 3 }] }, null, 2)

type Handler = (ctx: any, webDir: string) => Promise<boolean>
async function hit(handler: Handler, method: string, path: string, auth: Auth, body?: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = { 'content-type': 'application/json', ...headers }
  ;(req as any).url = path
  ;(req as any).method = method
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res, path: url.pathname, method, url, auth, fedPeer: null }, join(T.root, 'web'))).toBe(true)
  return { status: out.status || 200, body: out.body }
}
const refused = (r: { status: number; body: any }) => r.status === 403 && r.body?.code === 'owner_session_required'

// On macOS claudeAuthPresent asks the host's login Keychain (presence only), which answers from the host's own Claude
// login. The claude-auth cases run as linux, so the answer comes only from the throwaway files.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
async function asLinux<R>(fn: () => Promise<R>): Promise<R> {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' })
  try { return await fn() } finally { Object.defineProperty(process, 'platform', realPlatform) }
}
const onboardingOnLinux: Handler = (ctx) => asLinux(() => tryHandleOnboarding(ctx))

beforeEach(() => {
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  _clearDeviceKeyCacheForTest()
  rmSync(join(T.root, 'agents'), { recursive: true, force: true })
  mkdirSync(TG_DIR, { recursive: true })
  writeFileSync(join(AGENT_DIR, 'CLAUDE.md'), '# og4\n')
  writeFileSync(join(TG_DIR, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }))
  mkdirSync(join(T.root, 'store'), { recursive: true })
  writeFileSync(AUTONOMY, AUTONOMY_DOC)
  rmSync(join(T.root, 'store', 'federation.json'), { force: true })
  _setFederationStoreDirForTest(join(T.root, 'store'))
  reloadFederationForTest()
  settings.clear()
  for (const k of Object.keys(h) as Array<keyof typeof h>) h[k] = 0
})

// --- the first-run list on the real routes ----------------------------------------------------------------------
const FIRST_RUN_ROUTES: Array<{ why: string; handler: Handler; method: string; path: string; body?: unknown; expect: (r: { status: number; body: any }) => void }> = [
  { why: 'agent-create', handler: tryHandleAgents, method: 'POST', path: '/api/agents', body: { model: 'claude-opus-5', description: 'x' },
    expect: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('Name is required') } },
  { why: 'channel-setup', handler: tryHandleAgents, method: 'POST', path: `/api/agents/${AGENT}/channels/slack`, body: {},
    expect: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('botToken is required') } },
  { why: 'first-pairing', handler: tryHandleAgents, method: 'POST', path: `/api/agents/${AGENT}/channels/telegram/approve`, body: {},
    expect: (r) => { expect(r.status).toBe(400); expect(r.body.error).toBe('Code is required') } },
  { why: 'onboarding-identity', handler: tryHandleOnboarding, method: 'POST', path: '/api/onboarding/identity', body: {},
    expect: (r) => { expect(r.status).toBe(400); expect(r.body.reason).toBe('missing') } },
  { why: 'onboarding-claude-auth', handler: onboardingOnLinux, method: 'POST', path: '/api/onboarding/claude-auth', body: {},
    expect: (r) => { expect(r.status).toBe(400); expect(r.body.reason).toBe('missing') } },
  { why: 'claude-plans-login', handler: tryHandleClaudePlansLogin, method: 'GET', path: '/api/claude-plans/login/status',
    expect: (r) => { expect(r.status).toBe(200); expect(r.body.active).toBe(false) } },
  { why: 'first-login', handler: tryHandleAuth, method: 'POST', path: '/api/auth/users', body: { username: 'owner', password: 'super-secret-pw' },
    expect: (r) => { expect(r.status).toBe(201); expect(getDashboardUser('owner')).toBeDefined() } },
  { why: 'first-device', handler: tryHandleSecurity, method: 'POST', path: '/api/security/bridge-enroll', body: { key_line: 'x', name: '' },
    expect: (r) => { expect(r.status).toBe(400); expect(listDeviceKeys()).toHaveLength(0) } },
  { why: 'first-device', handler: tryHandleAuth, method: 'POST', path: '/api/auth/device-keys', body: { name: 'First Bridge' },
    expect: (r) => { expect(r.status).toBe(201); expect(listDeviceKeys()).toHaveLength(1) } },
]

describe('zero dashboard users: every FIRST_RUN_PATHS route lets the bare shared token past the owner gate', () => {
  it('the route table covers every entry of FIRST_RUN_PATHS', () => {
    expect([...new Set(FIRST_RUN_ROUTES.map((c) => c.why))].sort()).toEqual([...FIRST_RUN_PATHS].sort())
  })
  for (const c of FIRST_RUN_ROUTES) {
    it(`${c.why}: ${c.method} ${c.path} passes (then stops at its own validation or succeeds)`, async () => {
      const r = await hit(c.handler, c.method, c.path, TOKEN, c.body)
      expect(refused(r), JSON.stringify(r.body)).toBe(false)
      c.expect(r)
    })
    it(`${c.why}: ${c.method} ${c.path} refuses a sub-agent token`, async () => {
      const r = await hit(c.handler, c.method, c.path, SUBAGENT, c.body)
      expect(r.status).toBe(403)
      expect(listDashboardUsers()).toHaveLength(0)
      expect(listDeviceKeys()).toHaveLength(0)
    })
  }

  it('each first-run pass writes one audit line { why, path, method }, with no credential in it', () => {
    const spy = vi.spyOn(logger, 'info')
    const req = { url: '/api/agents?x=1', method: 'POST', headers: { authorization: 'Bearer secret-value' } } as unknown as http.IncomingMessage
    expect(mayActAsOwnerOrFirstRun(TOKEN, req, 'agent-create')).toBe(true)
    const lines = spy.mock.calls.filter((c) => String(c[1]).includes('first-run setup'))
    expect(lines).toHaveLength(1)
    expect(lines[0]![0]).toMatchObject({ why: 'agent-create', path: '/api/agents', method: 'POST' })
    expect(JSON.stringify(lines[0])).not.toContain('secret-value')
    spy.mockRestore()
  })
})

// --- every other formerly-loose route: 403 + setup_required, nothing written ---------------------------------------
describe('zero dashboard users: the formerly-loose routes off the list refuse the bare token with setup_required', () => {
  // A pending request the token may file (filing stays on the token); approving it is what is refused.
  const pendingApproval = async () => (await hit(tryHandleApprovals, 'POST', '/api/approvals', TOKEN, { agent_id: 'soma', category: 'email_send', action_description: 'og4' })).body
  const CASES: Array<{ label: string; run: () => Promise<{ status: number; body: any }>; unchanged: () => void }> = [
    { label: 'POST /api/approvals (born approved)',
      run: () => hit(tryHandleApprovals, 'POST', '/api/approvals', TOKEN, { agent_id: 'og4-main', category: 'email_send', action_description: 'x', content_hash: 'a'.repeat(64), owner_approved_message_id: 7 }),
      unchanged: () => {} },
    { label: 'PATCH /api/approvals/:id (approve)',
      run: async () => { const a = await pendingApproval(); (globalThis as any).__og4id = a.id; return hit(tryHandleApprovals, 'PATCH', `/api/approvals/${a.id}`, TOKEN, { status: 'approved', resolved_by: 'dashboard' }) },
      unchanged: () => { expect(getApproval((globalThis as any).__og4id)?.status).toBe('pending') } },
    { label: 'POST /api/autonomy (raise)',
      run: () => hit(tryHandleAutonomy, 'POST', '/api/autonomy', TOKEN, { key: 'email_send', level: 3 }),
      unchanged: () => { expect(readFileSync(AUTONOMY, 'utf-8')).toBe(AUTONOMY_DOC) } },
    { label: 'POST /api/settings (loosen BASH_SANDBOX_AGENTS)',
      run: () => { settings.set('BASH_SANDBOX_AGENTS', 'soma'); return hit(tryHandleSettings, 'POST', '/api/settings', TOKEN, { key: 'BASH_SANDBOX_AGENTS', value: '' }) },
      unchanged: () => { expect(h.settingWrites).toBe(0); expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma') } },
    { label: 'POST /api/skills/pending/:id/approve',
      run: () => hit(tryHandleSkills, 'POST', '/api/skills/pending/og4-nope/approve', TOKEN, { hash: 'x' }),
      unchanged: () => {} },
    { label: 'GET /api/fleet/export with the vault',
      run: () => hit(tryHandleFleet, 'GET', '/api/fleet/export', TOKEN, undefined, { 'x-vault-password': 'a-long-vault-password-og4' }),
      unchanged: () => { expect(h.exports).toBe(0) } },
    { label: 'POST /api/fleet/import?apply=true',
      run: () => hit(tryHandleFleet, 'POST', '/api/fleet/import?apply=true', TOKEN, { schemaVersion: 1 }),
      unchanged: () => { expect(h.imports).toBe(0) } },
    { label: 'POST /api/fleet/unfreeze',
      run: () => hit(tryHandleFleetFreeze, 'POST', '/api/fleet/unfreeze', TOKEN, {}),
      unchanged: () => { expect(h.unfreezes).toBe(0) } },
    { label: 'PUT /api/operator-access',
      run: () => hit(tryHandleOperatorAccess, 'PUT', '/api/operator-access', TOKEN, { enabled: true, agentControl: true }),
      unchanged: () => { expect(h.operatorWrites).toBe(0) } },
    { label: 'POST /api/federation/peers (add)',
      run: () => hit(tryHandleFederation, 'POST', '/api/federation/peers', TOKEN, { id: 'mallory', baseUrl: 'https://mallory.example' }),
      unchanged: () => { expect(getFederationConfig().peers).toEqual([]); expect(existsSync(join(T.root, 'store', 'federation.json'))).toBe(false) } },
    { label: 'GET /api/auth/users',
      run: () => hit(tryHandleAuth, 'GET', '/api/auth/users', TOKEN),
      unchanged: () => {} },
    { label: 'DELETE /api/auth/users/:name',
      run: () => hit(tryHandleAuth, 'DELETE', '/api/auth/users/owner', TOKEN),
      unchanged: () => { expect(listDashboardUsers()).toHaveLength(0) } },
    { label: 'DELETE /api/auth/device-keys/:id (revoke)',
      run: async () => { const k = createDeviceKey('Kept'); (globalThis as any).__og4key = k.id; return hit(tryHandleAuth, 'DELETE', `/api/auth/device-keys/${k.id}`, TOKEN) },
      unchanged: () => { expect(listDeviceKeys().map((k) => k.id)).toEqual([(globalThis as any).__og4key]) } },
  ]
  for (const c of CASES) {
    it(`${c.label}: 403 owner_session_required + setup_required, state unchanged`, async () => {
      const r = await c.run()
      expect(r.status, JSON.stringify(r.body)).toBe(403)
      expect(r.body.code).toBe('owner_session_required')
      expect(r.body.setup_required).toBe(true)
      c.unchanged()
    })
  }
})

// --- first-device ----------------------------------------------------------------------------------------------
describe("'first-device': only while no device key was ever issued", () => {
  const enroll = (auth: Auth) => hit(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', auth, { key_line: 'x', name: '' })
  const mint = (auth: Auth, name = 'Second') => hit(tryHandleAuth, 'POST', '/api/auth/device-keys', auth, { name })

  it('zero users and no key: enrolment and mint pass the gate', async () => {
    expect(deviceKeyEverIssued()).toBe(false)
    expect((await enroll(TOKEN)).status).toBe(400)
    expect((await mint(TOKEN, 'First')).status).toBe(201)
  })
  it('zero users and one existing key: both 403 setup_required, no second key', async () => {
    createDeviceKey('Existing')
    for (const r of [await enroll(TOKEN), await mint(TOKEN)]) {
      expect(refused(r)).toBe(true)
      expect(r.body.setup_required).toBe(true)
    }
    expect(listDeviceKeys()).toHaveLength(1)
  })
  it('zero users and a REVOKED key (no row left): still 403, the key once existed', async () => {
    revokeDeviceKey(createDeviceKey('Gone').id)
    expect(listDeviceKeys()).toHaveLength(0)
    expect(deviceKeyEverIssued()).toBe(true)
    expect(refused(await enroll(TOKEN))).toBe(true)
    expect(refused(await mint(TOKEN))).toBe(true)
    expect(listDeviceKeys()).toHaveLength(0)
  })
  it('zero users and an EXPIRED key row: still 403', async () => {
    createDeviceKey('Old', { expiresInDays: 1 })
    expect(deviceKeyEverIssued()).toBe(true)
    expect(refused(await mint(TOKEN))).toBe(true)
  })
  it('with a dashboard user it is strict: the bare token is 403 (no setup_required), the session passes', async () => {
    createDashboardUser('owner', 'x'.repeat(60))
    const r = await mint(TOKEN)
    expect(refused(r)).toBe(true)
    expect(r.body.setup_required).toBeUndefined()
    expect(refused(await enroll(TOKEN))).toBe(true)
    expect((await mint(SESSION, 'By the owner')).status).toBe(201)
  })
})

// --- first-login -----------------------------------------------------------------------------------------------
describe("'first-login': creating the FIRST dashboard login", () => {
  const addUser = (auth: Auth, username: string) => hit(tryHandleAuth, 'POST', '/api/auth/users', auth, { username, password: 'super-secret-pw' })
  it('zero users: the bare token creates it; with one user the bare token is 403 and no second user appears', async () => {
    expect((await addUser(TOKEN, 'owner')).status).toBe(201)
    const r = await addUser(TOKEN, 'mallory')
    expect(refused(r)).toBe(true)
    expect(getDashboardUser('mallory')).toBeUndefined()
  })
  it('zero users: a FULL device key (the window the first pairing opened) creates it; an operator key does not', async () => {
    expect((await addUser(OPERATOR_KEY, 'op')).status).toBe(403)
    expect((await addUser(FULL_KEY, 'owner')).status).toBe(201)
    expect((await addUser(FULL_KEY, 'second')).status).toBe(403)
    expect(listDashboardUsers().map((u) => u.username)).toEqual(['owner'])
  })
  // BRIDGEFIRSTLOGIN1106: the first login made with a device key is told to the owner's channel (Slack first, silent
  // with no channel: notifySecurityEvent); the notice names the login and the device, never a credential.
  it('the first login created with a FULL device key is told to the owner, naming the login and the device, no password', async () => {
    notices.length = 0
    expect((await addUser(FULL_KEY, 'owner')).status).toBe(201)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('owner')
    expect(notices[0]).toContain('Bridge')
    expect(notices[0]).not.toContain('super-secret-pw')
    expect(notices[0]).toContain('npm run dashboard-user -- remove owner')
    expect(notices[0]).toContain('npm run dashboard-user -- security:reset')
  })
  it('no notice for a first login made with the shared token, nor for a later login the owner adds', async () => {
    notices.length = 0
    expect((await addUser(TOKEN, 'owner')).status).toBe(201)
    expect((await addUser(SESSION, 'second')).status).toBe(201)
    expect(notices).toHaveLength(0)
  })
  it('a refused attempt sends no notice (an operator key, a second key-made login)', async () => {
    notices.length = 0
    expect((await addUser(OPERATOR_KEY, 'op')).status).toBe(403)
    createDashboardUser('owner', 'x'.repeat(60))
    expect((await addUser(FULL_KEY, 'second')).status).toBe(403)
    expect(notices).toHaveLength(0)
  })
})

// --- BRIDGEFIRSTLOGIN1106: who can hold a FULL device key while no dashboard login exists ---------------------
// The first login accepts a FULL device key at zero users. Over HTTP such a key comes only from the first-device path
// (while no key was ever issued); the owner-session branch cannot exist with zero users. The machine-local CLIs
// (scripts/bridge-device-key.ts, scripts/remote-access-enroll.ts --device-key) write the key store directly: they need
// a shell as the install user, which also reads the shared token, and the shared token creates the first login on its
// own ('first-login'), so a CLI key adds no power. The issuer list is pinned below: a new issuer cannot appear unseen.
describe('BRIDGEFIRSTLOGIN1106: at zero users the HTTP issuers give a FULL key only on the first-device path', () => {
  const enroll = (auth: Auth) => hit(tryHandleSecurity, 'POST', '/api/security/bridge-enroll', auth, { key_line: 'x', name: '' })
  const mint = (auth: Auth, name = 'Probe') => hit(tryHandleAuth, 'POST', '/api/auth/device-keys', auth, { name })
  it('a sub-agent token, an operator key and a FULL key cannot mint or enrol at zero users; nothing is issued', async () => {
    for (const a of [SUBAGENT, OPERATOR_KEY, FULL_KEY]) {
      expect((await mint(a)).status).toBe(403)
      expect((await enroll(a)).status).toBe(403)
    }
    expect(deviceKeyEverIssued()).toBe(false)
  })
  it('the shared token mints only the FIRST key; after it, mint and enrol are refused, and one key exists', async () => {
    expect((await mint(TOKEN, 'First')).status).toBe(201)
    expect(refused(await mint(TOKEN, 'Second'))).toBe(true)
    expect(refused(await enroll(TOKEN))).toBe(true)
    expect(listDeviceKeys()).toHaveLength(1)
  })
  it('the issuers of a device key are exactly the known ones (routes, the Bridge pairing, the two machine-local CLIs)', () => {
    const repo = join(__dirname, '..', '..')
    const files = execFileSync('git', ['-C', repo, 'grep', '-l', '-E', 'createDeviceKey\\(|mintBridgeDeviceKey\\(', '--', 'src', 'scripts', ':!src/__tests__'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).sort()
    expect(files).toEqual([
      'scripts/bridge-device-key.ts',
      'scripts/remote-access-enroll.ts',
      'src/web/auth-device-keys.ts',
      'src/web/bridge-enroll.ts',
      'src/web/routes/auth.ts',
    ])
  })
})

// --- the predicate ---------------------------------------------------------------------------------------------
describe('the predicate: a sub-agent token never passes, the bare token passes only the list, and only with zero users', () => {
  it('zero users', () => {
    expect(mayActAsOwner(TOKEN)).toBe(false)
    for (const why of FIRST_RUN_PATHS) {
      expect([why, mayActAsOwnerOrFirstRun(TOKEN, undefined, why)]).toEqual([why, true])
      expect([why, mayActAsOwnerOrFirstRun(SUBAGENT, undefined, why)]).toEqual([why, false])
      expect([why, mayActAsOwnerOrFirstRun(OPERATOR_KEY, undefined, why)]).toEqual([why, false])
      expect([why, mayActAsOwnerOrFirstRun(undefined, undefined, why)]).toEqual([why, false])
    }
  })
  it('one dashboard user', () => {
    createDashboardUser('owner', 'x'.repeat(60))
    for (const why of FIRST_RUN_PATHS) {
      expect([why, mayActAsOwnerOrFirstRun(TOKEN, undefined, why)]).toEqual([why, false])
      expect([why, mayActAsOwnerOrFirstRun(FULL_KEY, undefined, why)]).toEqual([why, false])
      expect([why, mayActAsOwnerOrFirstRun(SESSION, undefined, why)]).toEqual([why, true])
    }
  })
})

// --- OWNERGATE4-1104 (review, Samu 69637): three first-run paths only while the thing they write is still empty ------
const bytes = (p: string) => (existsSync(p) ? readFileSync(p).toString('base64') : '<absent>')
const ownerRefusal = (r: { status: number; body: any }, setup: boolean) => {
  expect(r.status, JSON.stringify(r.body)).toBe(403)
  expect(r.body.code).toBe('owner_session_required')
  expect(r.body.setup_required).toBe(setup ? true : undefined)
}
// A file the dashboard process cannot read (fail closed). Restored before the next case.
function unreadable(p: string): () => void {
  chmodSync(p, 0o000)
  return () => chmodSync(p, 0o600)
}

describe("'channel-setup': only while that agent's that channel is unconfigured", () => {
  const TG_ENV = join(TG_DIR, '.env')
  const TG_ACCESS = join(TG_DIR, 'access.json')
  const setup = (auth: Auth, body: unknown = { botToken: '999:new-bot' }, path = `/api/agents/${AGENT}/channels/telegram`) =>
    hit(tryHandleAgents, 'POST', path, auth, body)

  it('empty channel (no .env, access.json without a sender): the bare token passes the gate', async () => {
    const r = await setup(TOKEN, {})
    expect(refused(r)).toBe(false)
    expect(r.body.error).toBe('botToken is required')
  })
  it('a bot token already in the .env: 403 setup_required, .env and access.json byte for byte unchanged (new and legacy route)', async () => {
    writeFileSync(TG_ENV, 'TELEGRAM_BOT_TOKEN=111:owner-bot\n', { mode: 0o600 })
    const before = [bytes(TG_ENV), bytes(TG_ACCESS)]
    ownerRefusal(await setup(TOKEN), true)
    ownerRefusal(await setup(TOKEN, undefined, `/api/agents/${AGENT}/telegram`), true)
    expect([bytes(TG_ENV), bytes(TG_ACCESS)]).toEqual(before)
  })
  it('an approved sender (access.json allowFrom, or an approved/ marker) without a .env: 403, unchanged', async () => {
    writeFileSync(TG_ACCESS, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['4242'], groups: {}, pending: {} }))
    let before = bytes(TG_ACCESS)
    ownerRefusal(await setup(TOKEN), true)
    expect(bytes(TG_ACCESS)).toBe(before)
    expect(existsSync(TG_ENV)).toBe(false)
    writeFileSync(TG_ACCESS, JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }))
    mkdirSync(join(TG_DIR, 'approved'), { recursive: true })
    writeFileSync(join(TG_DIR, 'approved', '4242'), '')
    before = bytes(TG_ACCESS)
    ownerRefusal(await setup(TOKEN), true)
    expect(bytes(TG_ACCESS)).toBe(before)
  })
  it('another channel of the same agent stays open while this one is configured (per channel)', async () => {
    writeFileSync(TG_ENV, 'TELEGRAM_BOT_TOKEN=111:owner-bot\n', { mode: 0o600 })
    const r = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/channels/slack`, TOKEN, {})
    expect(r.body.error).toBe('botToken is required')
  })
  it("the main agent's channel (its own dir resolution): empty passes, configured is 403 and unchanged", async () => {
    const mainDir = join(T.root, 'main-slack-state')
    const saved = process.env.SLACK_STATE_DIR
    process.env.SLACK_STATE_DIR = mainDir
    try {
      const main = (body: unknown) => hit(tryHandleAgents, 'POST', '/api/agents/og4-main/channels/slack', TOKEN, body)
      expect((await main({})).body.error).toBe('botToken is required')
      mkdirSync(mainDir, { recursive: true })
      writeFileSync(join(mainDir, '.env'), 'SLACK_BOT_TOKEN=xoxb-owner\nSLACK_APP_TOKEN=xapp-owner\n', { mode: 0o600 })
      const before = bytes(join(mainDir, '.env'))
      ownerRefusal(await main({ botToken: 'xoxb-mallory', appToken: 'xapp-mallory' }), true)
      expect(bytes(join(mainDir, '.env'))).toBe(before)
      expect(existsSync(join(mainDir, 'access.json'))).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.SLACK_STATE_DIR; else process.env.SLACK_STATE_DIR = saved
      rmSync(mainDir, { recursive: true, force: true })
    }
  })
  it('with a dashboard user it is strict even on an empty channel: the bare token 403 (no setup_required), the session passes', async () => {
    createDashboardUser('owner', 'x'.repeat(60))
    ownerRefusal(await setup(TOKEN), false)
    expect(existsSync(TG_ENV)).toBe(false)
    expect((await setup(SESSION, {})).body.error).toBe('botToken is required')
  })
  it('fail closed: a malformed access.json, or a .env that cannot be read, counts as configured', async () => {
    writeFileSync(TG_ACCESS, '{ not json')
    ownerRefusal(await setup(TOKEN), true)
    expect(readFileSync(TG_ACCESS, 'utf-8')).toBe('{ not json')
    writeFileSync(TG_ACCESS, JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }))
    writeFileSync(TG_ENV, '', { mode: 0o600 })
    expect((await setup(TOKEN, {})).body.error).toBe('botToken is required')
    const restore = unreadable(TG_ENV)
    try {
      ownerRefusal(await setup(TOKEN), true)
    } finally { restore() }
    expect(readFileSync(TG_ENV, 'utf-8')).toBe('')
  })
})

describe("'onboarding-claude-auth': only while no Claude credential is stored yet", () => {
  const ENV = join(T.root, '.env')
  const FLEET = join(T.root, 'store', '.claude-oauth-token')
  const HOME_CREDS = join(T.root, 'home', '.claude', '.credentials.json')
  const NEW = { token: 'sk-ant-oat01-' + 'n'.repeat(40) }
  const auth = (a: Auth, body: unknown = NEW) => asLinux(() => hit(tryHandleOnboarding, 'POST', '/api/onboarding/claude-auth', a, body))
  beforeEach(() => {
    for (const f of [ENV, FLEET, HOME_CREDS]) rmSync(f, { force: true })
    mkdirSync(join(T.root, 'home', '.claude'), { recursive: true })
  })
  const snapshot = () => [bytes(ENV), bytes(FLEET), bytes(HOME_CREDS)]

  it('nothing stored: the bare token passes the gate', async () => {
    const r = await auth(TOKEN, {})
    expect(refused(r)).toBe(false)
    expect(r.body.reason).toBe('missing')
  })
  const SEEDS: Array<[string, () => void]> = [
    ['.env CLAUDE_CODE_OAUTH_TOKEN', () => writeFileSync(ENV, 'BOT_NAME=x\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-owner\n', { mode: 0o600 })],
    ['.env ANTHROPIC_API_KEY', () => writeFileSync(ENV, 'ANTHROPIC_API_KEY=sk-ant-api-owner\n', { mode: 0o600 })],
    ['the fleet token file', () => writeFileSync(FLEET, 'sk-ant-oat01-owner\n', { mode: 0o600 })],
    ['~/.claude/.credentials.json', () => writeFileSync(HOME_CREDS, JSON.stringify({ claudeAiOauth: { accessToken: 'owner' } }), { mode: 0o600 })],
  ]
  for (const [label, seed] of SEEDS) {
    it(`a credential in ${label}: 403 setup_required, every credential file byte for byte unchanged`, async () => {
      seed()
      const before = snapshot()
      ownerRefusal(await auth(TOKEN), true)
      ownerRefusal(await auth(TOKEN, { apiKey: 'sk-ant-api-mallory' }), true)
      expect(snapshot()).toEqual(before)
    })
  }
  it('with a dashboard user it is strict even with nothing stored: the bare token 403 (no setup_required), the session passes', async () => {
    createDashboardUser('owner', 'x'.repeat(60))
    ownerRefusal(await auth(TOKEN), false)
    expect(snapshot()).toEqual(['<absent>', '<absent>', '<absent>'])
    expect((await auth(SESSION, {})).body.reason).toBe('missing')
  })
  it('fail closed: an unreadable fleet token file or .env, or a credentials.json that is not JSON, counts as stored', async () => {
    writeFileSync(HOME_CREDS, '{ not json')
    ownerRefusal(await auth(TOKEN), true)
    rmSync(HOME_CREDS)
    for (const f of [FLEET, ENV]) {
      writeFileSync(f, '', { mode: 0o600 })
      const restore = unreadable(f)
      try {
        ownerRefusal(await auth(TOKEN), true)
      } finally { restore() }
      expect(readFileSync(f, 'utf-8')).toBe('')
      rmSync(f)
    }
    expect(existsSync(FLEET)).toBe(false)
  })
})

describe("'claude-plans-login': only while the install has no plan at all yet (Samu 69693)", () => {
  const PLANS = join(T.root, 'store', 'claude-plans.json')
  const VAULT = join(T.root, 'store', 'vault.json')
  const PLAN = { id: 'og4plan', label: 'Owner Max', planType: 'personal', channelsAllowed: true, tokenSecretId: 'claude-plan-token-og4plan' }
  // Missing label: a start that passes the gate stops at the field check (400 invalid-plan), before any login starts.
  const start = (a: Auth, id = 'og4plan') => hit(tryHandleClaudePlansLogin, 'POST', '/api/claude-plans/login/start', a, { id, planType: 'personal', channelsAllowed: true })
  beforeEach(() => { rmSync(PLANS, { force: true }); rmSync(VAULT, { force: true }) })

  it('no such plan: the bare token passes the gate', async () => {
    const r = await start(TOKEN)
    expect(refused(r)).toBe(false)
    expect(r.body.code).toBe('invalid-plan')
  })
  it('the target plan is registered: 403 setup_required (was 409 id-taken), the registry byte for byte unchanged', async () => {
    writeFileSync(PLANS, JSON.stringify([PLAN], null, 2) + '\n')
    const before = bytes(PLANS)
    ownerRefusal(await start(TOKEN), true)
    expect(bytes(PLANS)).toBe(before)
  })
  it('only a vault token under the target id (no registry row): 403, the vault unchanged', async () => {
    writeFileSync(VAULT, JSON.stringify({ entries: [{ id: 'claude-plan-token-og4plan', label: 'x', encrypted: 'e', createdAt: 'c', updatedAt: 'u' }] }), { mode: 0o600 })
    const before = bytes(VAULT)
    ownerRefusal(await start(TOKEN), true)
    expect(bytes(VAULT)).toBe(before)
  })
  it('a plan exists: a NEW plan id is refused too (403 setup_required), nothing is created (a new plan could be the rotate target)', async () => {
    writeFileSync(PLANS, JSON.stringify([PLAN]))
    const before = bytes(PLANS)
    ownerRefusal(await start(TOKEN, 'og4other'), true)
    expect(bytes(PLANS)).toBe(before)
  })
  it('a plan token in the vault under ANOTHER id (no registry row): the first-run is closed for every id', async () => {
    writeFileSync(VAULT, JSON.stringify({ entries: [{ id: 'claude-plan-token-somebody', label: 'x', encrypted: 'e', createdAt: 'c', updatedAt: 'u' }] }), { mode: 0o600 })
    ownerRefusal(await start(TOKEN, 'og4plan'), true)
  })
  it('control: a vault entry that is not a plan token does not count as a plan, the bare token passes', async () => {
    writeFileSync(VAULT, JSON.stringify({ entries: [{ id: 'GOOGLE_API', label: 'x', encrypted: 'e', createdAt: 'c', updatedAt: 'u' }] }), { mode: 0o600 })
    expect((await start(TOKEN)).body.code).toBe('invalid-plan')
  })
  it('with a dashboard user it is strict even for a new id: the bare token 403 (no setup_required), the session passes', async () => {
    createDashboardUser('owner', 'x'.repeat(60))
    ownerRefusal(await start(TOKEN), false)
    expect((await start(SESSION)).body.code).toBe('invalid-plan')
  })
  // Review (Samu 69720): a missing store DIR is not the fresh-install state (that is a missing file in an existing
  // store), it is a drifted path or a vanished store; and an unreadable vault file holds something. Both count as
  // holding a plan: the first-run path stays closed.
  it('fail closed: the store dir itself missing counts as holding a plan (403 setup_required)', async () => {
    const store = join(T.root, 'store')
    const aside = join(T.root, 'store-aside-og4')
    renameSync(store, aside)
    try {
      ownerRefusal(await start(TOKEN), true)
    } finally { renameSync(aside, store) }
  })
  it('fail closed: an unreadable vault file counts as holding a plan', async () => {
    writeFileSync(VAULT, JSON.stringify({ entries: [] }), { mode: 0o600 })
    const restore = unreadable(VAULT)
    try {
      ownerRefusal(await start(TOKEN), true)
    } finally { restore() }
  })
  it('control: an existing store dir without either file is the fresh install, the bare token passes', async () => {
    expect((await start(TOKEN)).body.code).toBe('invalid-plan')
  })

  it('fail closed: a malformed registry, a malformed vault, or an unreadable registry counts as holding the credential', async () => {
    writeFileSync(PLANS, '[ not json')
    ownerRefusal(await start(TOKEN), true)
    expect(readFileSync(PLANS, 'utf-8')).toBe('[ not json')
    rmSync(PLANS)
    writeFileSync(VAULT, '{"entries": 7}')
    ownerRefusal(await start(TOKEN), true)
    rmSync(VAULT)
    writeFileSync(PLANS, '[]')
    const restore = unreadable(PLANS)
    try {
      ownerRefusal(await start(TOKEN), true)
    } finally { restore() }
  })
})

describe("'agent-create' (first-run without a condition) cannot overwrite an EXISTING agent", () => {
  function tree(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) { const p = join(e.parentPath, e.name); out[p] = readFileSync(p).toString('base64') }
    }
    return out
  }
  it('zero users + bare token + the name of an existing agent dir: 409, its files unchanged', async () => {
    const saved = process.env[CLI_VERSION_OVERRIDE_ENV]
    process.env[CLI_VERSION_OVERRIDE_ENV] = '' // unmeasured CLI: no probe of a real claude binary, nothing refused
    try {
      const before = tree(AGENT_DIR)
      for (const name of [AGENT, 'OG4Agent']) {
        const r = await hit(tryHandleAgents, 'POST', '/api/agents', TOKEN, { name, description: 'mallory', model: 'claude-opus-5' })
        expect(r.status, JSON.stringify(r.body)).toBe(409)
        expect(r.body.error).toBe('Agent already exists')
      }
      expect(tree(AGENT_DIR)).toEqual(before)
    } finally {
      if (saved === undefined) delete process.env[CLI_VERSION_OVERRIDE_ENV]; else process.env[CLI_VERSION_OVERRIDE_ENV] = saved
    }
  })
})
