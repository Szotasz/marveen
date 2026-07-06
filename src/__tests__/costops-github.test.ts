import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { mapGitHubUsage, githubCollector, syncGitHubCollector } from '../costops/collectors/github.js'
import { monthWindow } from '../costops/ledger.js'
import type { CollectOpts } from '../costops/collectors/types.js'

const START = Math.floor(Date.UTC(2026, 6, 1) / 1000)
const END = Math.floor(Date.UTC(2026, 7, 1) / 1000)

function report(amounts: number[]) {
  return { usageItems: amounts.map((a, i) => ({ date: '2026-07-0' + (i + 1), product: 'actions', sku: 'x', quantity: 1, unitType: 'min', netAmount: a })) }
}

describe('mapGitHubUsage (pure, offline)', () => {
  it('sums netAmount USD into one HUF provider_api line for github', () => {
    const lines = mapGitHubUsage(report([2, 3]), { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })
    expect(lines).toHaveLength(1)
    expect(lines[0].provider).toBe('github')
    expect(lines[0].confidence).toBe('provider_api')
    expect(lines[0].amount).toBe(Math.round(5 * 360 * 100) / 100)
    expect(lines[0].dedup_key).toBe('provider|github|github|2026-07|provider_api')
  })

  it('emits an EXPLICIT 0 provider_api line on a valid empty report (API-observed zero)', () => {
    const lines = mapGitHubUsage({ usageItems: [] }, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })
    expect(lines).toHaveLength(1)
    expect(lines[0].amount).toBe(0)
    expect(lines[0].confidence).toBe('provider_api')
  })

  it('returns [] only when the raw is not a usage report', () => {
    expect(mapGitHubUsage(null, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
    expect(mapGitHubUsage({ message: 'Not Found' }, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
  })
})

describe('githubCollector + syncGitHubCollector (offline stub)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('sync imports a provider_api line (even at 0) with a stubbed key + fetcher; idempotent', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const r1 = await syncGitHubCollector(db, now, { apiKey: 'ghp-stub', fxUsdHuf: 360, httpGetJson: async () => report([]) })
    expect(r1.ok).toBe(true)
    expect(r1.imported_count).toBe(1)
    const row = db.prepare("SELECT billed_cost, confidence FROM cost_line_items WHERE source_id='github'").get() as { billed_cost: number; confidence: string }
    expect(row.billed_cost).toBe(0)
    expect(row.confidence).toBe('provider_api')
    // idempotent
    await syncGitHubCollector(db, now, { apiKey: 'ghp-stub', fxUsdHuf: 360, httpGetJson: async () => report([]) })
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='github'").get() as { c: number }).c).toBe(1)
    const audit = JSON.stringify(db.prepare('SELECT * FROM import_runs').all())
    expect(audit).not.toContain('ghp-stub')
  })

  it('errors (no import) when the vault token is missing', async () => {
    const db = getDb()
    const r = await syncGitHubCollector(db, Math.floor(Date.now() / 1000), { apiKey: null, fxUsdHuf: 360, httpGetJson: async () => report([1]) })
    expect(r.ok).toBe(false)
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='github'").get() as { c: number }).c).toBe(0)
  })
})
