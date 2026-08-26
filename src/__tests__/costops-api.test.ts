import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { tryHandleCosts, startCostsSyncTask } from '../web/routes/costs.js'
import { monthWindow } from '../costops/ledger.js'
import { COSTOPS_CONFIG_PATH } from '../costops/config.js'
import type { RouteContext } from '../web/routes/types.js'

// Minimal fake ServerResponse capturing what json() writes.
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('costops API (route smoke)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('GET /api/costs/summary returns a well-formed read-only summary', async () => {
    // seed a current-month token_usage row -> proves volume is reported but NOT priced
    const now = Math.floor(Date.now() / 1000)
    const w = monthWindow(now)
    getDb().prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES ('marveen','s',?,1234,5678,0,0)").run(w.start + 100)

    const { ctx, out } = fakeCtx('/api/costs/summary')
    const handled = await tryHandleCosts(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    // shape
    expect(out.body).toHaveProperty('month')
    expect(out.body).toHaveProperty('current_spend')
    expect(out.body).toHaveProperty('forecast_month_end')
    expect(out.body).toHaveProperty('top_sources')
    expect(out.body).toHaveProperty('confidence_breakdown')
    expect(out.body).toHaveProperty('breakdown')
    expect(out.body).toHaveProperty('budget')
    expect(out.body).toHaveProperty('token_usage')
    // token usage reported as VOLUME, plus a labelled list-price equivalent
    expect(out.body.token_usage.input_tokens).toBe(1234)
    expect(out.body.token_usage.output_tokens).toBe(5678)
    expect(out.body.token_usage.note).toContain('LIST-PRICE EQUIVALENT')
    expect(out.body.token_usage.list_price_equivalent.basis).toBe('list_price_equivalent')
    expect(out.body.token_usage.list_price_equivalent.currency).toBe('USD')
    // money never derived from tokens (config amounts are 0 placeholders)
    expect(typeof out.body.current_spend).toBe('number')
    // no secret / account id leaks into the response
    expect(JSON.stringify(out.body)).not.toMatch(/secret|api[_-]?key|password|token=/i)
  })

  it('GET /api/costs/tokens prices a rolling window and labels its basis', async () => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model) VALUES ('marveen','s',?,0,1000000,0,0,'claude-opus-5')").run(now - 3600)
    const { ctx, out } = fakeCtx('/api/costs/tokens?days=7')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.basis).toBe('list_price_equivalent')
    expect(out.body.currency).toBe('USD')
    expect(out.body.total).toBeCloseTo(25, 6) // 1M output tokens at $25/1M
    expect(out.body.by_model[0].model).toBe('claude-opus-5')
  })

  it('GET /api/costs/tokens clamps an absurd or unparseable days parameter', async () => {
    // The window is attacker-visible input on a bearer-gated route; an
    // unbounded lookback would turn a read into a full-table scan.
    const now = Math.floor(Date.now() / 1000)
    for (const [q, maxDays] of [['days=99999', 400], ['days=abc', 7], ['days=-5', 1]] as const) {
      const { ctx, out } = fakeCtx(`/api/costs/tokens?${q}`)
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(out.status).toBe(200)
      const spanDays = (out.body.window.end - out.body.window.start) / 86400
      expect(spanDays, `${q} produced a ${spanDays}-day window`).toBeLessThanOrEqual(maxDays)
      expect(out.body.window.end).toBeGreaterThanOrEqual(now - 5)
    }
  })

  it('GET /api/costs/sources returns an array', async () => {
    const { ctx, out } = fakeCtx('/api/costs/sources')
    expect(await tryHandleCosts(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('falls through (returns false) for unrelated paths', async () => {
    const { ctx } = fakeCtx('/api/kanban')
    expect(await tryHandleCosts(ctx)).toBe(false)
  })

  // Review blocker (Szotasz, PR #524): "the GET endpoint performs writes". Proven with a
  // REAL fixed cost configured (not the empty default), so there is something a buggy
  // sync-on-GET would actually have inserted -- an empty-config test wouldn't distinguish
  // "no write call" from "nothing to write".
  describe('GET /api/costs/summary is read-only (review blocker regression)', () => {
    const hadConfig = existsSync(COSTOPS_CONFIG_PATH)
    beforeEach(() => {
      mkdirSync(dirname(COSTOPS_CONFIG_PATH), { recursive: true })
      writeFileSync(COSTOPS_CONFIG_PATH, JSON.stringify({
        version: 1, currency: 'HUF',
        fixed_costs: [{ source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000 }],
        budgets: [],
      }))
    })
    afterEach(() => { if (!hadConfig) { try { unlinkSync(COSTOPS_CONFIG_PATH) } catch { /* already gone */ } } })

    it('never inserts into cost_line_items/cost_sources, even with a real fixed cost configured', async () => {
      const { ctx } = fakeCtx('/api/costs/summary')
      expect(await tryHandleCosts(ctx)).toBe(true)
      expect(await tryHandleCosts(ctx)).toBe(true) // twice, to also rule out a one-shot lazy-write pattern
      const items = (getDb().prepare('SELECT COUNT(*) as n FROM cost_line_items').get() as { n: number }).n
      const sources = (getDb().prepare('SELECT COUNT(*) as n FROM cost_sources').get() as { n: number }).n
      expect(items).toBe(0)
      expect(sources).toBe(0)
    })

    it('startCostsSyncTask() is where the write actually happens, and it works', () => {
      startCostsSyncTask(24 * 60 * 60 * 1000) // long interval -- test only needs the immediate one-shot run
      const row = getDb().prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-max'").get() as { billed_cost: number } | undefined
      expect(row?.billed_cost).toBe(22000)
    })
  })
})
