// POST /api/claude-plans/:id/probe, through tryHandleClaudePlans() with the
// same fake req/res harness as claude-plans-routes.test.ts. The vault is an
// in-memory Map and the global fetch is stubbed: no real token, no network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-probe-test-'))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, MAIN_AGENT_ID: 'agent-a', DEFAULT_AGENT_MODEL: 'claude-opus-5' }))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: () => '' }))
vi.mock('../web/channel-monitor.js', () => ({ hardRestartMarveenChannels: () => ({ ok: true }) }))
vi.mock('../web/agent-process.js', () => ({ restartAgentProcess: async () => ({ ok: true }) }))

const vaultSecrets = new Map<string, string>()
vi.mock('../web/vault.js', () => ({
  setSecret: (id: string, _label: string, value: string) => { vaultSecrets.set(id, value) },
  deleteSecret: (id: string) => vaultSecrets.delete(id),
  getSecret: (id: string) => vaultSecrets.get(id) ?? null,
}))

const { tryHandleClaudePlans } = await import('../web/routes/claude-plans.js')
const { CLAUDE_PLANS_PATH, writeClaudePlans } = await import('../web/claude-plans.js')
const { CLAUDE_PLANS_STATE_PATH, readClaudePlansState, writeClaudePlansState } = await import('../web/claude-plans-state.js')

const FAKE_TOKEN = 'sk-ant-oat01-' + 'FAKEROUTETOKEN'.repeat(5)
const NOW_S = Math.floor(Date.now() / 1000)

function fakeCtx(method: string, path: string): { ctx: any; out: { status: number; raw: string; body: any } } {
  const out = { status: 0, raw: '', body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { out.raw = chunk; out.body = JSON.parse(chunk) } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = { on(event: string, cb: () => void) { if (event === 'end') cb() } }
  return { ctx: { req, res, path: url.pathname, method, url }, out }
}

const HEADERS_OK = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
  'anthropic-ratelimit-unified-5h-reset': String(NOW_S + 3600),
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.9',
  'anthropic-ratelimit-unified-7d-reset': String(NOW_S + 86400),
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
}

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200, headers: HEADERS_OK }))

describe('POST /api/claude-plans/:id/probe', () => {
  beforeEach(() => {
    if (existsSync(CLAUDE_PLANS_PATH)) rmSync(CLAUDE_PLANS_PATH)
    if (existsSync(CLAUDE_PLANS_STATE_PATH)) rmSync(CLAUDE_PLANS_STATE_PATH)
    vaultSecrets.clear()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    writeClaudePlans([
      { id: 'tok', label: 'Token plan', tokenSecretId: 'claude-plan-token-tok', planType: 'personal', channelsAllowed: true },
      { id: 'dir', label: 'Dir plan', configDir: '/opt/claude-dir', planType: 'personal', channelsAllowed: true },
    ])
    vaultSecrets.set('claude-plan-token-tok', FAKE_TOKEN)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('probes a token-mode plan, returns parsed usage, never the token', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/tok/probe')
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.usage.fiveHour).toEqual({ usedPercent: 42, resetsAt: NOW_S + 3600, status: 'allowed' })
    expect(out.body.usage.sevenDay.usedPercent).toBe(90)
    expect(out.raw).not.toContain(FAKE_TOKEN)
    expect(out.raw).not.toContain('FAKEROUTETOKEN')
    // ...while the token DID go out, in the Authorization header only.
    const init = fetchMock.mock.calls[0][1]
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
  })

  it('records the observation (incl. seven_day) without marking the plan active', async () => {
    writeClaudePlansState({ activePlanByAgent: { 'agent-a': 'dir' }, plans: {} })
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans/tok/probe').ctx)
    const state = readClaudePlansState()
    expect(state.activePlanByAgent).toEqual({ 'agent-a': 'dir' })
    expect(state.plans.tok.source).toBe('probe')
    expect(state.plans.tok.windows.five_hour.usedPercent).toBe(42)
    expect(state.plans.tok.windows.seven_day.usedPercent).toBe(90)
    expect(readFileSync(CLAUDE_PLANS_STATE_PATH, 'utf8')).not.toContain('FAKEROUTETOKEN')
  })

  it('422 for a configDir-mode plan, without any network call', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/dir/probe')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(422)
    expect(out.body.error).toBe('probe needs a token-mode plan')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('404 for an unknown plan', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/nope/probe')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('409 when the token is missing from the vault (no fleet-token fallback)', async () => {
    vaultSecrets.clear()
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/tok/probe')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('401 upstream -> 502 invalid_token, failure recorded in lastProbe, token absent', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 401 }))
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/tok/probe')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(502)
    expect(out.body.error).toBe('invalid_token')
    expect(out.raw).not.toContain('FAKEROUTETOKEN')
    expect(readClaudePlansState().plans.tok.lastProbe).toMatchObject({ ok: false, error: 'invalid_token', httpStatus: 401 })
  })

  it('429 with headers -> 200 carrying the exhausted usage', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', {
      status: 429,
      headers: { ...HEADERS_OK, 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-7d-utilization': '1' },
    }))
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/tok/probe')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: false, error: 'rate_limited', httpStatus: 429 })
    expect(out.body.usage.sevenDay.usedPercent).toBe(100)
    expect(readClaudePlansState().plans.tok.overallStatus).toBe('rejected')
  })
})
