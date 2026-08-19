import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { mapOpenAiCosts, openaiCollector, syncOpenAiCollector } from '../costops/collectors/openai.js'
import { monthWindow } from '../costops/ledger.js'
import type { CollectOpts } from '../costops/collectors/types.js'

// Fixture modelling the OpenAI /v1/organizations/costs page shape.
function fixturePage(vals: number[]) {
  const now = Math.floor(Date.UTC(2026, 6, 1) / 1000)
  return {
    object: 'page',
    data: vals.map((v, i) => ({
      object: 'bucket',
      start_time: now + i * 86400,
      end_time: now + (i + 1) * 86400,
      results: [{ object: 'organization.costs.result', amount: { value: v, currency: 'usd' }, line_item: null, project_id: null }],
    })),
    has_more: false,
    next_page: null,
  }
}

const START = Math.floor(Date.UTC(2026, 6, 1) / 1000)
const END = Math.floor(Date.UTC(2026, 7, 1) / 1000)

describe('mapOpenAiCosts (pure, offline)', () => {
  it('sums daily USD costs into one HUF provider_api line for openai-api', () => {
    const lines = mapOpenAiCosts(fixturePage([1.5, 2.0, 0.5]), { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 'salt', now: START })
    expect(lines).toHaveLength(1)
    const l = lines[0]
    expect(l.provider).toBe('openai')
    expect(l.service).toBe('openai-api')
    expect(l.confidence).toBe('provider_api')
    expect(l.currency).toBe('HUF')
    expect(l.amount).toBe(Math.round(4.0 * 360 * 100) / 100) // (1.5+2.0+0.5)*360
    expect(l.dedup_key).toBe('provider|openai|openai-api|2026-07|provider_api')
    expect(l.raw_ref_hash).not.toContain('openai-costs') // hashed, no raw
  })

  it('returns [] for an empty page (caller reports explicit 0)', () => {
    expect(mapOpenAiCosts({ object: 'page', data: [] }, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
    expect(mapOpenAiCosts(null, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
  })
})

describe('openaiCollector + syncOpenAiCollector (offline stub, no live call)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('collect() returns normalized lines from the injected fetcher (no network)', async () => {
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const w = monthWindow(now)
    const opts: CollectOpts = {
      periodStart: w.start, periodEnd: w.end, secret: 'sk-admin-never-logged', fxUsdHuf: 360, idSalt: 'openai-salt',
      httpGetJson: async () => fixturePage([3.0, 1.0]),
    }
    const lines = await openaiCollector.collect(opts)
    expect(lines).toHaveLength(1)
    expect(lines[0].amount).toBe(Math.round(4.0 * 360 * 100) / 100)
  })

  it('sync imports a provider_api line + import_run using a stubbed key and fetcher (idempotent)', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const stub = async () => fixturePage([2.0, 2.0])
    const r1 = await syncOpenAiCollector(db, now, { apiKey: 'sk-admin-stub', fxUsdHuf: 360, httpGetJson: stub })
    expect(r1.ok).toBe(true)
    expect(r1.imported_count).toBe(1)
    const lineCount = () => (db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='openai-api'").get() as { c: number }).c
    expect(lineCount()).toBe(1)
    const r2 = await syncOpenAiCollector(db, now, { apiKey: 'sk-admin-stub', fxUsdHuf: 360, httpGetJson: stub })
    expect(r2.ok).toBe(true)
    expect(lineCount()).toBe(1) // idempotent upsert by dedup_key

    // secret must not leak into the import_runs audit rows
    const audit = JSON.stringify(db.prepare('SELECT * FROM import_runs').all())
    expect(audit).not.toContain('sk-admin-stub')
  })

  it('reports error (no import) when the vault key is missing', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const r = await syncOpenAiCollector(db, now, { apiKey: null, fxUsdHuf: 360, httpGetJson: async () => fixturePage([1]) })
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='openai-api'").get() as { c: number }).c).toBe(0)
  })
})
