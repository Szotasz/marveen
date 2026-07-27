import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/openrouter-models.js', () => ({
  loadOpenRouterCatalog: vi.fn().mockReturnValue({ updated: 0, tiers: [] }),
  fetchAllOpenRouterModels: vi.fn().mockResolvedValue([]),
  loadCuratedManual: vi.fn().mockReturnValue([]),
  addCuratedManual: vi.fn().mockReturnValue([{ id: 'openai/gpt-4', name: 'GPT-4' }]),
  removeCuratedManual: vi.fn().mockReturnValue([]),
}))
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: vi.fn().mockReturnValue([]),
}))

import { tryHandleAgentsModels } from '../web/routes/agents-models.js'

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleAgentsModels', () => {
  it('GET /api/models/available returns claude list and empty deepseek/openrouter when keys absent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/models/available')
    const handled = await tryHandleAgentsModels(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.claude)).toBe(true)
    expect(out.body.claude.length).toBeGreaterThan(0)
    expect(out.body.deepseek).toEqual([])
    expect(out.body.openrouter).toBeNull()
    expect(out.body.deepseekConfigured).toBe(false)
    expect(out.body.openrouterConfigured).toBe(false)
  })

  it('GET /api/models/available includes deepseek when key present', async () => {
    const vault = await import('../web/vault.js')
    vi.mocked(vault.getSecret).mockImplementation((id: string) =>
      id === 'DEEPSEEK_API_KEY' ? 'ds-secret' : null
    )
    const { ctx, out } = makeCtx('GET', '/api/models/available')
    await tryHandleAgentsModels(ctx)
    expect(out.body.deepseek.length).toBeGreaterThan(0)
    expect(out.body.deepseekConfigured).toBe(true)
    vi.mocked(vault.getSecret).mockReturnValue(null)
  })

  it('GET /api/openrouter/manual returns 403 when key absent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/openrouter/manual')
    const handled = await tryHandleAgentsModels(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(403)
  })

  it('POST /api/openrouter/manual returns 403 when key absent', async () => {
    const { ctx, out } = makeCtx('POST', '/api/openrouter/manual', { id: 'gpt-4', checked: true })
    const handled = await tryHandleAgentsModels(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(403)
  })

  it('GET /api/openrouter/manual returns list when key present', async () => {
    const vault = await import('../web/vault.js')
    vi.mocked(vault.getSecret).mockReturnValue('or-key')
    const { ctx, out } = makeCtx('GET', '/api/openrouter/manual')
    await tryHandleAgentsModels(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.models)).toBe(true)
    vi.mocked(vault.getSecret).mockReturnValue(null)
  })

  it('POST /api/openrouter/manual returns 400 when id missing', async () => {
    const vault = await import('../web/vault.js')
    vi.mocked(vault.getSecret).mockReturnValue('or-key')
    const { ctx, out } = makeCtx('POST', '/api/openrouter/manual', { checked: true })
    await tryHandleAgentsModels(ctx)
    expect(out.status).toBe(400)
    vi.mocked(vault.getSecret).mockReturnValue(null)
  })

  it('POST /api/openrouter/manual adds model when checked=true', async () => {
    const vault = await import('../web/vault.js')
    vi.mocked(vault.getSecret).mockReturnValue('or-key')
    const { ctx, out } = makeCtx('POST', '/api/openrouter/manual', { id: 'openai/gpt-4', checked: true })
    await tryHandleAgentsModels(ctx)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    vi.mocked(vault.getSecret).mockReturnValue(null)
  })

  it('GET /api/openrouter/models returns 403 when key absent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/openrouter/models')
    await tryHandleAgentsModels(ctx)
    expect(out.status).toBe(403)
  })

  it('GET /api/claude-plans returns plan list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/claude-plans')
    const handled = await tryHandleAgentsModels(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleAgentsModels(ctx)).toBe(false)
  })
})
