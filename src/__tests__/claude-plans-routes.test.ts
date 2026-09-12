// PR2b route wiring: POST/PUT/DELETE /api/claude-plans and GET .../state.
// PR2c adds POST .../rotate, exercised through tryHandleClaudePlans() directly
// (mirrors approvals-notify.test.ts's fake req/res harness). PROJECT_ROOT
// points at a real temp dir so the CRUD round-trips through the actual
// atomic-write path. hardRestartMarveenChannels/restartAgentProcess are
// mocked -- this test must NEVER touch a real tmux session or process.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-routes-test-'))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, MAIN_AGENT_ID: 'agent-a', DEFAULT_AGENT_MODEL: 'claude-opus-5' }))

let rotationEnabled = '0'
let mainIsolated = '0'
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => {
    if (key === 'CLAUDE_ROTATION_ENABLED') return rotationEnabled
    if (key === 'MAIN_AGENT_ISOLATED_CONFIG') return mainIsolated
    return ''
  },
}))

const hardRestartMarveenChannels = vi.fn((): { ok: boolean; error?: string } => ({ ok: true }))
vi.mock('../web/channel-monitor.js', () => ({ hardRestartMarveenChannels: () => hardRestartMarveenChannels() }))

const restartAgentProcess = vi.fn(
  async (_name: string): Promise<{ ok: boolean; pid?: number; error?: string }> => ({ ok: true, pid: 123 }),
)
vi.mock('../web/agent-process.js', () => ({ restartAgentProcess: (name: string) => restartAgentProcess(name) }))

const { tryHandleClaudePlans } = await import('../web/routes/claude-plans.js')
const { CLAUDE_PLANS_PATH } = await import('../web/claude-plans.js')
const { CLAUDE_PLANS_STATE_PATH } = await import('../web/claude-plans-state.js')

function fakeCtx(method: string, path: string, body?: unknown): { ctx: any; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method, url }, out }
}

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pro',
    label: 'Personal PRO',
    configDir: '/opt/claude-pro',
    planType: 'personal',
    channelsAllowed: true,
    ...over,
  }
}

describe('tryHandleClaudePlans', () => {
  beforeEach(() => {
    if (existsSync(CLAUDE_PLANS_PATH)) rmSync(CLAUDE_PLANS_PATH)
  })

  it('GET returns an empty list when no registry exists', async () => {
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans')
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.body).toEqual([])
  })

  it('POST creates a plan, then GET lists it', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan())
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ id: 'pro', label: 'Personal PRO' })

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body.map((p: any) => p.id)).toEqual(['pro'])
  })

  it('POST rejects an invalid plan (400) without writing anything', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan({ planType: 'enterprise' }))
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(false)
  })

  it('POST rejects a duplicate id (409)', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const dup = fakeCtx('POST', '/api/claude-plans', plan({ label: 'Second' }))
    await tryHandleClaudePlans(dup.ctx)
    expect(dup.out.status).toBe(409)
  })

  it('PUT updates an existing plan; a differing id in the body is ignored', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)

    const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/pro', plan({ id: 'someone-else', label: 'Renamed' }))
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ id: 'pro', label: 'Renamed' })

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body).toHaveLength(1)
    expect(list.out.body[0].label).toBe('Renamed')
  })

  it('PUT on an unknown id returns 404', async () => {
    const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/nope', plan())
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(404)
  })

  it('PUT with an invalid body returns 400 and leaves the plan untouched', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/pro', plan({ channelsAllowed: 'yes' }))
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body[0].channelsAllowed).toBe(true)
  })

  it('DELETE removes a plan', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const { ctx, out } = fakeCtx('DELETE', '/api/claude-plans/pro')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body).toEqual([])
  })

  it('DELETE on an unknown id returns 404', async () => {
    const { ctx, out } = fakeCtx('DELETE', '/api/claude-plans/nope')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(404)
  })

  it('GET .../state reports an empty state when nothing has ever rotated', async () => {
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans/state')
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.body).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('a plan literally named "state" cannot shadow the state route', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'state' })).ctx)
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(ctx)
    expect(out.body).toEqual({ activePlanByAgent: {}, plans: {} })
  })
})

describe('POST /api/claude-plans/rotate (PR2c)', () => {
  const agentsDir = join(tmpRoot, 'agents')

  beforeEach(() => {
    if (existsSync(CLAUDE_PLANS_PATH)) rmSync(CLAUDE_PLANS_PATH)
    if (existsSync(CLAUDE_PLANS_STATE_PATH)) rmSync(CLAUDE_PLANS_STATE_PATH)
    if (existsSync(agentsDir)) rmSync(agentsDir, { recursive: true, force: true })
    rotationEnabled = '1'
    mainIsolated = '1'
    hardRestartMarveenChannels.mockClear().mockReturnValue({ ok: true })
    restartAgentProcess.mockClear().mockResolvedValue({ ok: true, pid: 123 })
  })

  async function seedTwoPlans() {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro', label: 'Personal PRO' })).ctx)
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'team', label: 'Team Seat' })).ctx)
  }

  it('rejects with 400 when targetPlanId is missing', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', {})
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects with 400 for an unknown targetPlanId', async () => {
    await seedTwoPlans()
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'nope' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('rejects with 400 when the target plan does not allow channels', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'team', label: 'Team', channelsAllowed: false })).ctx)
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects with 409 when CLAUDE_ROTATION_ENABLED is off', async () => {
    await seedTwoPlans()
    rotationEnabled = '0'
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(409)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('rejects with 409 for the main agent when MAIN_AGENT_ISOLATED_CONFIG is off', async () => {
    await seedTwoPlans()
    mainIsolated = '0'
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(409)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('rejects with 409 for the main agent with fewer than 2 registered plans', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'pro' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(409)
  })

  it('happy path (main agent, default agentId): writes state THEN restarts, in that order', async () => {
    await seedTwoPlans()
    const order: string[] = []
    hardRestartMarveenChannels.mockImplementation(() => { order.push('restart'); return { ok: true } })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, agentId: 'agent-a', activePlanId: 'team' })
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(1)

    const state = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(state.ctx)
    expect(state.out.body.activePlanByAgent).toEqual({ 'agent-a': 'team' })
  })

  it('this is also how a first-ever assignment happens -- no separate bootstrap path', async () => {
    // No prior activePlanByAgent entry for agent-a: applyRotation just adds one.
    await seedTwoPlans()
    const { ctx } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'pro' })
    await tryHandleClaudePlans(ctx)
    const state = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(state.ctx)
    expect(state.out.body.activePlanByAgent['agent-a']).toBe('pro')
  })

  it('returns 500 and does not report ok when the main-agent restart fails', async () => {
    await seedTwoPlans()
    hardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'launchctl boom' })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toContain('launchctl boom')
  })

  it('sub-agent path: 404 when the agent does not exist', async () => {
    await seedTwoPlans()
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { agentId: 'devy', targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(404)
    expect(restartAgentProcess).not.toHaveBeenCalled()
  })

  it('sub-agent path: writes claudePlan + restarts via restartAgentProcess, not the main-agent path', async () => {
    await seedTwoPlans()
    mkdirSync(join(agentsDir, 'devy'), { recursive: true })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { agentId: 'devy', targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, agentId: 'devy', activePlanId: 'team' })
    expect(restartAgentProcess).toHaveBeenCalledWith('devy')
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()

    const state = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(state.ctx)
    expect(state.out.body.activePlanByAgent.devy).toBe('team')
  })

  it('sub-agent path is NOT gated on MAIN_AGENT_ISOLATED_CONFIG or the 2-plan minimum', async () => {
    // Only design 6.2's main-agent precondition mentions isolation; a
    // sub-agent's claudePlan field is a normal per-agent setting already,
    // unrelated to the main agent's auth mode.
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    mainIsolated = '0'
    mkdirSync(join(agentsDir, 'devy'), { recursive: true })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { agentId: 'devy', targetPlanId: 'pro' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
  })
})
