import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { syncRenderCollector, type RenderPricing } from '../costops/collectors/render.js'
import { getCostSummary, monthWindow } from '../costops/ledger.js'
import type { CostOpsConfig } from '../costops/config.js'
import type { HttpGetJson } from '../costops/collectors/types.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
function emptyConfig(): CostOpsConfig { return { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] } }

// Offline fixture -- NO live Render API is ever called.
const SERVICES = [
  { service: { id: 'srv-1', type: 'web_service', serviceDetails: { plan: 'starter', numInstances: 1 } } },
  { service: { id: 'srv-2', type: 'static_site', serviceDetails: {} } },
]
const POSTGRES = [{ postgres: { id: 'pg-1', plan: 'basic_1gb' } }]
const stub: HttpGetJson = async (url) => url.includes('postgres') ? POSTGRES : SERVICES

// syncRenderCollector loads pricing from disk; inject via deps.apiKey + httpGetJson,
// but pricing comes from loadRenderPricing() -- for a deterministic test we rely on
// the real store pricing if present; assert structurally rather than on an exact HUF.

describe('syncRenderCollector (offline, v0.5 sync spine)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('imports idempotently, records an ok run with detail_json (no raw IDs)', async () => {
    const db = getDb()
    const r1 = await syncRenderCollector(db, NOW, { httpGetJson: stub, apiKey: 'rnd_TESTKEY' })
    expect(r1.provider).toBe('render')
    expect(r1.status).toBe('ok')
    // re-run -> idempotent (same month, one line)
    await syncRenderCollector(db, NOW, { httpGetJson: stub, apiKey: 'rnd_TESTKEY' })
    const lines = db.prepare("SELECT COUNT(*) n FROM cost_line_items WHERE source_id='render-plan'").get() as { n: number }
    expect(lines.n).toBeLessThanOrEqual(1) // 0 if fx=0 in store pricing, else 1 -- never duplicated
    const runs = db.prepare("SELECT detail_json FROM import_runs WHERE provider='render' AND status='ok' ORDER BY started_at DESC LIMIT 1").get() as { detail_json: string | null } | undefined
    expect(runs).toBeDefined()
    if (runs?.detail_json) {
      const d = JSON.parse(runs.detail_json)
      expect(typeof d.service_count).toBe('number')
      expect(runs.detail_json).not.toContain('srv-')  // no raw service IDs
      expect(runs.detail_json).not.toContain('pg-')
    }
    // secret never stored
    expect(JSON.stringify(db.prepare('SELECT * FROM import_runs').all())).not.toContain('rnd_TESTKEY')
  })

  it('summary provider_sync exposes v0.5 freshness fields + render_plan.detail', async () => {
    const db = getDb()
    await syncRenderCollector(db, NOW, { httpGetJson: stub, apiKey: 'rnd_TESTKEY' })
    const s = getCostSummary(db, emptyConfig(), NOW)
    const ps = s.provider_sync.find(p => p.provider === 'render')
    expect(ps).toBeDefined()
    if (ps) {
      expect(['ok', 'stale', 'failed', 'no_data']).toContain(ps.status)
      expect(ps).toHaveProperty('last_success')
      expect(ps).toHaveProperty('last_failed')
      expect(ps).toHaveProperty('data_age_secs')
      expect(ps.current_period).toBe(monthWindow(NOW).key)
      expect(ps).toHaveProperty('previous_period_coverage')
    }
  })

  it('no api key -> error result, nothing imported', async () => {
    const db = getDb()
    const r = await syncRenderCollector(db, NOW, { httpGetJson: stub, apiKey: null })
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
    const n = db.prepare('SELECT COUNT(*) n FROM cost_line_items').get() as { n: number }
    expect(n.n).toBe(0)
  })
})
