// MODEPRESETS1109: bounded token authority, with byte snapshots of every refused write.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

// Isolate all config/state under this worktree, including from concurrent owner-gate suites.
const TEST_ROOT = vi.hoisted(() => `${process.cwd()}/.mode-presets-test-${process.pid}-${Date.now()}`)
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  PROJECT_ROOT: TEST_ROOT,
  STORE_DIR: `${TEST_ROOT}/store`,
  MAIN_AGENT_ID: 'test-main-agent',
}))
const runtime = vi.hoisted(() => ({
  runState: 'running' as 'running' | 'stopped' | 'unreachable',
  desired: new Set<string>(),
  restart: vi.fn(async (_name: string, _opts: { fresh: boolean }) => ({ ok: true, error: undefined as string | undefined })),
}))
vi.mock('../web/agent-process.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-process.js')>()),
  agentRunState: () => runtime.runState,
  restartAgentProcess: runtime.restart,
}))
vi.mock('../web/agent-desired-state.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-desired-state.js')>()),
  getDesiredAgents: () => runtime.desired,
}))
vi.mock('../web/context-guard-store.js', async (orig) => {
  const real = await orig<typeof import('../web/context-guard-store.js')>()
  return { ...real, mergeContextGuardConfig: vi.fn(real.mergeContextGuardConfig) }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const real = await orig<typeof import('../web/agent-config.js')>()
  return { ...real, writeAgentMode: vi.fn(real.writeAgentMode) }
})
// MODEPRESETS1109: deterministic CLI probes and audit call assertions, without child processes.
vi.mock('../web/claude-cli-version.js', async (orig) => ({
  ...(await orig<typeof import('../web/claude-cli-version.js')>()),
  measureClaudeCliVersion: vi.fn(async () => ({ version: '0.0.1', measuredAt: 0, error: null, source: 'env' as const })),
}))
vi.mock('../claude-cli-support.js', async (orig) => {
  const real = await orig<typeof import('../claude-cli-support.js')>()
  return { ...real, isModelUnsupportedByCli: vi.fn(real.isModelUnsupportedByCli) }
})
vi.mock('../db.js', async (orig) => {
  const real = await orig<typeof import('../db.js')>()
  return { ...real, logConfigChange: vi.fn(real.logConfigChange) }
})

mkdirSync(join(TEST_ROOT, 'store'), { recursive: true })
const { initDatabase, getDb, createDashboardUser, logConfigChange } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME, isAgentAllowed } = await import('../web/auth-gate.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { tryHandleModePresets } = await import('../web/routes/mode-presets.js')
const { agentDir, writeAgentMode } = await import('../web/agent-config.js')
const { mergeContextGuardConfig, CONTEXT_GUARD_STORE_PATH } = await import('../web/context-guard-store.js')
const { measureClaudeCliVersion } = await import('../web/claude-cli-version.js')
const { isModelUnsupportedByCli } = await import('../claude-cli-support.js')
const { InvalidModelIdError } = await import('../model-id.js')
const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')
const { MODE_PRESETS_PATH, normaliseModePresets, validateModePresets, readModePresets } = await import('../web/mode-presets.js')

const AGENT = 'test-agent-a'
const PEER = 'test-agent-b'
const CONFIG_PATH = join(agentDir(AGENT), 'agent-config.json')
const PEER_CONFIG_PATH = join(agentDir(PEER), 'agent-config.json')
const GUARD_PATH = CONTEXT_GUARD_STORE_PATH
const PROVIDERS_PATH = join(TEST_ROOT, 'store', 'custom-providers.json')
const TOKEN: RouteContext['auth'] = { kind: 'token' }
const cheap = {
  customProvider: 'test-provider', model: 'test-model', agents: [AGENT],
  contextGuard: { limitTokens: 120000, actPct: 0.4, hardPct: 0.5 },
}
const presets = () => ({ presets: {
  'preset-cheap': structuredClone(cheap),
  'preset-claude': { customProvider: '', model: 'test-built-in-model', agents: [AGENT] },
} })
type Handler = (ctx: RouteContext, webDir: string) => Promise<boolean>
async function hit(handler: Handler, method: string, path: string, body?: unknown, auth = TOKEN, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as http.IncomingMessage
  req.headers = headers
  req.url = path
  req.method = method
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(status: number) { out.status = status; return res }, setHeader() {},
    end(value?: string) { if (value) out.body = JSON.parse(value) },
  } as unknown as http.ServerResponse
  const url = new URL(path, 'http://127.0.0.1:3420')
  expect(await handler({ req, res, path, method, url, auth }, join(TEST_ROOT, 'web'))).toBe(true)
  return out
}
const apply = (body: unknown = { preset: 'preset-cheap' }, name = AGENT, auth = TOKEN) => hit(tryHandleAgents, 'POST', `/api/agents/${name}/mode`, body, auth)
const bytes = (file: string) => existsSync(file) ? readFileSync(file) : null
const snapshot = () => [CONFIG_PATH, PEER_CONFIG_PATH, GUARD_PATH, MODE_PRESETS_PATH].map(bytes)
const audit = () => getDb().prepare('SELECT key, old_value, new_value, actor FROM config_change_log ORDER BY id').all() as Array<{
  key: string; old_value: string; new_value: string; actor: string
}>
let ownerId = 0
const ownerCookie = () => ({ cookie: `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}` })
function unchanged(before: ReturnType<typeof snapshot>) {
  expect(snapshot()).toEqual(before)
  expect(runtime.restart).not.toHaveBeenCalled()
  expect(writeAgentMode).not.toHaveBeenCalled()
  expect(mergeContextGuardConfig).not.toHaveBeenCalled()
  expect(audit()).toEqual([])
  expect(logConfigChange).not.toHaveBeenCalled()
}

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM config_change_log')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  for (const name of [AGENT, PEER]) {
    mkdirSync(agentDir(name), { recursive: true })
    writeFileSync(join(agentDir(name), 'agent-config.json'), '{ "model": "test-original-model", "customProvider": "", "keep": true }\n')
  }
  writeFileSync(GUARD_PATH, JSON.stringify({
    [AGENT]: { ...DEFAULT_CONTEXT_GUARD, enabled: true, idleMinutes: 23 },
    [PEER]: { ...DEFAULT_CONTEXT_GUARD, enabled: false },
  }, null, 2) + '\n')
  writeFileSync(MODE_PRESETS_PATH, JSON.stringify(presets(), null, 2))
  writeFileSync(PROVIDERS_PATH, JSON.stringify({ providers: [{ id: 'test-provider', label: 'Test', baseUrl: 'http://127.0.0.1:1', authHeader: 'none', vaultKey: null }] }))
  runtime.runState = 'running'
  runtime.desired = new Set([AGENT])
  runtime.restart.mockReset().mockResolvedValue({ ok: true, error: undefined })
  vi.mocked(writeAgentMode).mockClear()
  vi.mocked(mergeContextGuardConfig).mockClear()
  vi.mocked(measureClaudeCliVersion).mockClear()
  vi.mocked(isModelUnsupportedByCli).mockClear()
  vi.mocked(logConfigChange).mockClear()
})
afterAll(() => { rmSync(TEST_ROOT, { recursive: true, force: true }) })

describe('owner-managed preset configuration', () => {
  it('refuses the shared token before reading a body', async () => {
    const before = snapshot()
    const result = await hit(tryHandleModePresets, 'PUT', '/api/mode-presets', 'invalid JSON')
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('owner_session_required')
    unchanged(before)
  })
  it('writes and audits a PUT with the shared token and owner cookie', async () => {
    const next = presets()
    next.presets['preset-cheap'].contextGuard.limitTokens = 150000
    const result = await hit(tryHandleModePresets, 'PUT', '/api/mode-presets', next, TOKEN, ownerCookie())
    expect(result.status).toBe(200)
    expect(JSON.parse(readFileSync(MODE_PRESETS_PATH, 'utf-8'))).toEqual(next)
    expect(audit()).toEqual([{ key: 'mode-presets', old_value: JSON.stringify(presets()), new_value: JSON.stringify(next), actor: 'token' }])
  })
  it('rejects an invalid built-in provider model without writing', async () => {
    const before = snapshot()
    const body = { presets: { 'preset-claude': { customProvider: '', model: 'bad model; id', agents: [AGENT] } } }
    const result = await hit(tryHandleModePresets, 'PUT', '/api/mode-presets', body, TOKEN, ownerCookie())
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('Invalid model id')
    unchanged(before)
  })
  const invalid = [
    { presets: { 'Bad Name': cheap } },
    { presets: { 'preset-cheap': { ...cheap, agents: [] } } },
    { presets: { 'preset-cheap': { ...cheap, agents: ['*'] } } },
    { presets: { 'preset-cheap': { ...cheap, contextGuard: { actPct: 0.8, hardPct: 0.5 } } } },
    { presets: { 'preset-cheap': { ...cheap, unknown: true } } },
    { presets: { 'preset-cheap': { ...cheap, contextGuard: { enabled: true } } } },
    { presets: { 'preset-cheap': { ...cheap, model: 'bad model; id' } } },
    { presets: { 'preset-cheap': { ...cheap, contextGuard: { limitTokens: 1.5 } } } },
    { presets: { 'preset-cheap': { ...cheap, contextGuard: { actPct: 0 } } } },
    { presets: { 'preset-cheap': { ...cheap, contextGuard: { hardPct: 1.01 } } } },
    { presets: {}, unknown: true },
  ]
  it.each(invalid)('rejects an invalid owner PUT without writing (%#)', async body => {
    const before = snapshot()
    const result = await hit(tryHandleModePresets, 'PUT', '/api/mode-presets', body, TOKEN, ownerCookie())
    expect(result.status).toBe(400)
    expect(result.body.error).toEqual(expect.any(String))
    unchanged(before)
  })
  it('GET follows the operator-access read lanes and returns normalized content', async () => {
    expect((await hit(tryHandleModePresets, 'GET', '/api/mode-presets')).body).toEqual(presets())
    expect((await hit(tryHandleModePresets, 'GET', '/api/mode-presets', undefined, { kind: 'device', scope: 'full' })).status).toBe(403)
  })
  it('normalizes unknown fields and drops invalid entries without widening agents', () => {
    const raw = { unknown: true, presets: {
      'preset-cheap': { ...cheap, unknown: true, contextGuard: { ...cheap.contextGuard, unknown: true } },
      'preset-claude': { ...cheap, agents: [] },
      'Bad Name': cheap,
    } }
    expect(normaliseModePresets(raw)).toEqual({ presets: { 'preset-cheap': cheap } })
    expect(() => validateModePresets(raw)).toThrow()
    expect(validateModePresets({ presets: { 'preset-cheap': { ...cheap, contextGuard: { limitTokens: null, actPct: 1, hardPct: 1 } } } })).toBeTruthy()
  })
})

describe('preset application refusals', () => {
  it('an absent body is 400 with unchanged bytes', async () => {
    const before = snapshot()
    const result = await hit(tryHandleAgents, 'POST', `/api/agents/${AGENT}/mode`)
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('mode_invalid_body')
    unchanged(before)
  })
  for (const [label, body] of [
    ['missing preset', {}], ['non-string preset', { preset: 1 }],
    ['unknown key', { preset: 'preset-cheap', model: 'test-model' }],
    ['invalid fresh', { preset: 'preset-cheap', fresh: 'true' }],
    ['invalid JSON', '{'], ['array body', []], ['null body', null],
  ] as const) {
    it(`${label}: 400 with unchanged bytes`, async () => {
      const before = snapshot()
      const result = await apply(body)
      expect(result.status).toBe(400)
      expect(result.body.code).toBe('mode_invalid_body')
      unchanged(before)
    })
  }
  it('unknown agent is refused before reading the body', async () => {
    rmSync(agentDir(PEER), { recursive: true })
    const before = snapshot()
    const result = await apply({}, PEER)
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('mode_agent_unknown')
    expect(result.body.error).toBe('Agent not found')
    unchanged(before)
  })
  it.each(['preset-unknown', 'constructor', '__proto__'])('unknown preset %s is 404', async preset => {
    const before = snapshot()
    const result = await apply({ preset })
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('mode_preset_unknown')
    expect(measureClaudeCliVersion).not.toHaveBeenCalled()
    unchanged(before)
  })
  it('drops an invalid built-in provider model stored directly in the preset file', async () => {
    const stored = { presets: { 'preset-claude': { customProvider: '', model: 'bad model; id', agents: [AGENT] } } }
    writeFileSync(MODE_PRESETS_PATH, JSON.stringify(stored))
    const before = snapshot()
    expect(normaliseModePresets(stored)).toEqual({ presets: {} })
    const result = await apply({ preset: 'preset-claude' })
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('mode_preset_unknown')
    expect(measureClaudeCliVersion).not.toHaveBeenCalled()
    unchanged(before)
  })
  it('agent not explicitly listed is 403', async () => {
    const before = snapshot()
    const result = await apply({ preset: 'preset-cheap' }, PEER)
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('mode_preset_not_allowed')
    unchanged(before)
  })
  it('a removed provider is 409', async () => {
    writeFileSync(PROVIDERS_PATH, '{"providers":[]}')
    const before = snapshot()
    const result = await apply()
    expect(result.status).toBe(409)
    expect(result.body.code).toBe('mode_preset_provider_missing')
    expect(measureClaudeCliVersion).not.toHaveBeenCalled()
    unchanged(before)
  })
  it.each(['preset-cheap', 'preset-claude'] as const)('refuses %s when the measured CLI cannot launch its model', async preset => {
    const before = snapshot()
    vi.mocked(isModelUnsupportedByCli).mockReturnValueOnce(true)
    const result = await apply({ preset })
    expect(result.status).toBe(422)
    expect(result.body.code).toBe('mode_model_not_launchable')
    expect(result.body.installedCli).toBe('0.0.1')
    expect(measureClaudeCliVersion).toHaveBeenCalledExactlyOnceWith({ fresh: true })
    expect(isModelUnsupportedByCli).toHaveBeenCalledExactlyOnceWith(presets().presets[preset].model, '0.0.1')
    unchanged(before)
  })
  it('main agent is refused before reading a body', async () => {
    const before = snapshot()
    const result = await apply({}, 'test-main-agent')
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('mode_main_agent_unsupported')
    unchanged(before)
  })
  it('per-agent tokens are refused by the allowlist and the handler', async () => {
    const before = snapshot()
    expect(isAgentAllowed(`/api/agents/${AGENT}/mode`, 'POST', AGENT)).toBe(false)
    const result = await apply({ preset: 'preset-cheap' }, AGENT, { kind: 'token', tokenAgent: AGENT })
    expect(result.status).toBe(403)
    expect(result.body.code).toBe('mode_agent_token_forbidden')
    unchanged(before)
  })
  it('malformed preset storage fails closed', async () => {
    writeFileSync(MODE_PRESETS_PATH, '{')
    const before = snapshot()
    const result = await apply()
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('mode_preset_unknown')
    expect(readModePresets()).toEqual({ presets: {} })
    unchanged(before)
  })
  it.each([{ limitTokens: 1 }, { actPct: 1 }, { hardPct: 0.1 }])('rejects a guard patch the dry run would change (%#)', async contextGuard => {
    writeFileSync(MODE_PRESETS_PATH, JSON.stringify({ presets: { 'preset-cheap': { ...cheap, contextGuard } } }))
    const before = snapshot()
    const result = await apply()
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('mode_preset_context_guard_invalid')
    unchanged(before)
  })
})

describe('atomic mode changes and lifecycle', () => {
  it.each(['', 'test-provider'])('the writer rejects an invalid model with provider %j', customProvider => {
    const before = snapshot()
    expect(() => writeAgentMode(AGENT, customProvider, 'bad model; id')).toThrow(InvalidModelIdError)
    expect(snapshot()).toEqual(before)
    expect(logConfigChange).not.toHaveBeenCalled()
    expect(runtime.restart).not.toHaveBeenCalled()
  })
  it('sets both config fields, merges guard keys, audits once and restarts once', async () => {
    const originalGuard = JSON.parse(readFileSync(GUARD_PATH, 'utf-8'))
    const result = await apply()
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, preset: 'preset-cheap', changed: true, restarted: true })
    expect(writeAgentMode).toHaveBeenCalledExactlyOnceWith(AGENT, 'test-provider', 'test-model')
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))).toEqual({ model: 'test-model', customProvider: 'test-provider', keep: true })
    const guard = JSON.parse(readFileSync(GUARD_PATH, 'utf-8'))
    expect(guard[AGENT]).toEqual({ ...originalGuard[AGENT], ...cheap.contextGuard })
    expect(guard[PEER]).toEqual(originalGuard[PEER])
    expect(runtime.restart).toHaveBeenCalledExactlyOnceWith(AGENT, { fresh: false })
    expect(audit()).toEqual([{
      key: `agent-mode:${AGENT}`, actor: 'token',
      old_value: JSON.stringify({ customProvider: '', model: 'test-original-model', contextGuard: { limitTokens: null, actPct: DEFAULT_CONTEXT_GUARD.actPct, hardPct: DEFAULT_CONTEXT_GUARD.hardPct } }),
      new_value: JSON.stringify({ customProvider: 'test-provider', model: 'test-model', contextGuard: cheap.contextGuard }),
    }])
  })
  it('a second identical apply writes nothing, audits nothing and does not restart', async () => {
    await apply()
    const before = snapshot()
    const rows = audit()
    const inodes = [CONFIG_PATH, GUARD_PATH].map(p => statSync(p).ino)
    runtime.restart.mockClear()
    vi.mocked(writeAgentMode).mockClear()
    vi.mocked(mergeContextGuardConfig).mockClear()
    const result = await apply()
    expect(result.body).toEqual({ ok: true, preset: 'preset-cheap', changed: false, restarted: false })
    expect(snapshot()).toEqual(before)
    expect([CONFIG_PATH, GUARD_PATH].map(p => statSync(p).ino)).toEqual(inodes)
    expect(runtime.restart).not.toHaveBeenCalled()
    expect(writeAgentMode).not.toHaveBeenCalled()
    expect(mergeContextGuardConfig).not.toHaveBeenCalled()
    expect(audit()).toEqual(rows)
  })
  it.each([
    ['stopped', true], ['stopped', false], ['unreachable', true],
  ] as const)('saves without starting an agent that is %s (desired: %s)', async (state, desired) => {
    runtime.runState = state
    runtime.desired = new Set(desired ? [AGENT] : [])
    const result = await apply()
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, preset: 'preset-cheap', changed: true, restarted: false })
    expect(runtime.restart).not.toHaveBeenCalled()
    expect(audit()).toHaveLength(1)
  })
  it('passes fresh through for a running agent, even when absent from desired state', async () => {
    runtime.desired.clear()
    const result = await apply({ preset: 'preset-cheap', fresh: true })
    expect(result.body.restarted).toBe(true)
    expect(runtime.restart).toHaveBeenCalledExactlyOnceWith(AGENT, { fresh: true })
  })
  it('built-in provider clears the custom provider and leaves guard bytes alone', async () => {
    await apply()
    const guard = bytes(GUARD_PATH)
    vi.mocked(mergeContextGuardConfig).mockClear()
    const result = await apply({ preset: 'preset-claude' })
    expect(result.status).toBe(200)
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))).toEqual({ model: 'test-built-in-model', keep: true })
    expect(bytes(GUARD_PATH)).toEqual(guard)
    expect(mergeContextGuardConfig).not.toHaveBeenCalled()
  })
  it.each([undefined, null, ''])('an existing built-in model with provider %j is a no-op', async customProvider => {
    const config: Record<string, unknown> = { model: presets().presets['preset-claude'].model, keep: true }
    if (customProvider !== undefined) config.customProvider = customProvider
    writeFileSync(CONFIG_PATH, JSON.stringify(config))
    const before = snapshot()
    const result = await apply({ preset: 'preset-claude' })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true, preset: 'preset-claude', changed: false, restarted: false })
    unchanged(before)
  })
  it.each([false, true])('restores both files when the guard write throws (after write: %s)', async afterWrite => {
    const before = snapshot()
    vi.mocked(mergeContextGuardConfig).mockImplementationOnce(() => {
      // The one config write already contains BOTH approved values before the second write.
      expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))).toMatchObject({ customProvider: 'test-provider', model: 'test-model' })
      if (afterWrite) writeFileSync(GUARD_PATH, '{"partial":true}')
      throw new Error('test guard write failed')
    })
    const result = await apply()
    expect(result.status).toBe(500)
    expect(result.body.error).toBe('test guard write failed')
    expect(snapshot()).toEqual(before)
    expect(runtime.restart).not.toHaveBeenCalled()
    expect(audit()).toEqual([])
  })
  it('rollback restores missing files to absence', async () => {
    rmSync(CONFIG_PATH)
    rmSync(GUARD_PATH)
    const before = snapshot()
    vi.mocked(mergeContextGuardConfig).mockImplementationOnce(() => { throw new Error('test guard write failed') })
    expect((await apply()).status).toBe(500)
    expect(snapshot()).toEqual(before)
    expect(runtime.restart).not.toHaveBeenCalled()
    expect(audit()).toEqual([])
  })
  it.each(['throw', 'failure'])('restart %s returns 502 with applied true and retains the audit', async failure => {
    if (failure === 'throw') runtime.restart.mockRejectedValueOnce(new Error('test restart failed'))
    else runtime.restart.mockResolvedValueOnce({ ok: false, error: 'test restart failed' })
    const result = await apply()
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: 'test restart failed', applied: true })
    expect(JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')).customProvider).toBe('test-provider')
    expect(audit()).toHaveLength(1)
    expect(runtime.restart).toHaveBeenCalledTimes(1)
  })
})
