import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { tryHandleCosts } from '../web/routes/costs.js'
import { MAIN_AGENT_SETTINGS_PATH, DEFAULT_ECO_MODEL } from '../costops/eco-mode.js'
import type { RouteContext } from '../web/routes/types.js'

/**
 * HTTP wiring for the eco switch. Every case here is deliberately
 * non-mutating: GET, a rejected target, and an explicit dry run. The write
 * path is covered against temp files in costops-eco-mode.test.ts, so this
 * suite never rewrites a tracked config to prove a point.
 */

function fakeCtx(path: string, method = 'GET', body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))])
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

function settingsSnapshot() {
  return readFileSync(MAIN_AGENT_SETTINGS_PATH, 'utf-8')
}

describe('GET /api/costs/eco', () => {
  it('reports the current state and a preview', async () => {
    const { ctx, out } = fakeCtx('/api/costs/eco')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.state).toHaveProperty('enabled')
    expect(out.body.preview.plan).toHaveProperty('changes')
  })

  it('always says a restart is still required', async () => {
    // The whole point of F2: config only. Anything reading this response must
    // be told the change has not taken effect yet.
    const { ctx, out } = fakeCtx('/api/costs/eco')
    await tryHandleCosts(ctx)
    expect(out.body.preview.restart_required).toBe(true)
    expect(out.body.preview.note).toContain('does not perform')
  })

  it('writes nothing', async () => {
    const before = settingsSnapshot()
    const { ctx } = fakeCtx('/api/costs/eco')
    await tryHandleCosts(ctx)
    expect(settingsSnapshot()).toBe(before)
  })
})

describe('POST /api/costs/eco', () => {
  it('refuses an unknown target model instead of writing it', async () => {
    // A model string with no published rate is not a harmless typo: the
    // agent's next launch fails on it. The skill's naming gotcha in practice.
    const before = settingsSnapshot()
    const { ctx, out } = fakeCtx('/api/costs/eco', 'POST', { enabled: true, target: 'claude-sonnet-4-8' })
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('claude-sonnet-4-8')
    expect(out.body.known).toContain(DEFAULT_ECO_MODEL)
    expect(settingsSnapshot(), 'a bad target reached the config file').toBe(before)
  })

  it('accepts a suffixed form of a known model', async () => {
    const { ctx, out } = fakeCtx('/api/costs/eco', 'POST', { enabled: true, target: 'claude-sonnet-5[1m]', dry_run: true })
    await tryHandleCosts(ctx)
    expect(out.status).toBe(200)
    expect(out.body.plan.target).toBe('claude-sonnet-5[1m]')
  })

  it('dry run returns a plan and changes nothing', async () => {
    const before = settingsSnapshot()
    const { ctx, out } = fakeCtx('/api/costs/eco', 'POST', { enabled: true, dry_run: true })
    await tryHandleCosts(ctx)
    expect(out.status).toBe(200)
    expect(out.body.applied).toEqual([])
    expect(out.body.restart_required).toBe(true)
    expect(settingsSnapshot()).toBe(before)
  })
})
