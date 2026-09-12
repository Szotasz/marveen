// PR2b route wiring: POST/PUT/DELETE /api/claude-plans and GET .../state,
// exercised through tryHandleClaudePlans() directly (mirrors
// approvals-notify.test.ts's fake req/res harness). PROJECT_ROOT points at a
// real temp dir so the CRUD round-trips through the actual atomic-write path.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-routes-test-'))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, MAIN_AGENT_ID: 'agent-a', DEFAULT_AGENT_MODEL: 'claude-opus-5' }))

const { tryHandleClaudePlans } = await import('../web/routes/claude-plans.js')
const { CLAUDE_PLANS_PATH } = await import('../web/claude-plans.js')

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
    expect(out.body).toEqual({ activePlanId: null, plans: {} })
  })

  it('a plan literally named "state" cannot shadow the state route', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'state' })).ctx)
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(ctx)
    expect(out.body).toEqual({ activePlanId: null, plans: {} })
  })
})
