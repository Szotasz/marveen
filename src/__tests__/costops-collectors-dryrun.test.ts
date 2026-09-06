import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { anthropicCollector } from '../costops/collectors/anthropic.js'
import { dryRunCollector, describeShape } from '../costops/collectors/runner.js'
import { monthWindow } from '../costops/ledger.js'
import type { CollectOpts, HttpGetJson } from '../costops/collectors/types.js'

const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const FX = 308.91
const SECRET = 'sk-DRYRUN-must-not-leak-9876543210'

// Offline fixture -- NO live API is ever called in tests.
const FIXTURE = {
  data: [{
    starting_at: '2026-07-01T00:00:00Z',
    ending_at: '2026-07-31T00:00:00Z',
    results: [
      { currency: 'USD', amount: '30', cost_type: 'api_usage', model: 'claude-opus-4-8' },
      { currency: 'USD', amount: '20', cost_type: 'api_usage', model: 'claude-sonnet-4-6' },
    ],
  }],
  has_more: false,
}

function opts(httpGetJson: HttpGetJson): CollectOpts {
  const w = monthWindow(NOW)
  return { periodStart: w.start, periodEnd: w.end, secret: SECRET, fxUsdHuf: FX, idSalt: 'salt', httpGetJson }
}

describe('describeShape (types only, no values)', () => {
  it('returns structure with no scalar values', () => {
    const shape = describeShape(FIXTURE)
    // shape carries keys + types + array lengths, but NOT the numbers/strings themselves
    const dump = JSON.stringify(shape)
    expect(dump).not.toContain('claude-opus-4-8')  // no model value
    expect(dump).not.toContain('30')               // no amount value
    expect(dump).not.toContain('2026-07-01')       // no date value
    // but the schema IS described
    expect(shape).toMatchObject({ type: 'object' })
    expect((shape as any).keys.data).toMatchObject({ type: 'array', length: 1 })
    expect((shape as any).keys.data.of.keys.results).toMatchObject({ type: 'array', length: 2 })
    expect((shape as any).keys.has_more).toBe('boolean')
  })
})

describe('dryRunCollector (offline, persists NOTHING to cost_line_items)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('normalizes and shows planned lines + dedup_keys + response shape', async () => {
    const stub: HttpGetJson = async () => FIXTURE
    const rep = await dryRunCollector({ db: getDb(), collector: anthropicCollector, opts: opts(stub), now: NOW })
    expect(rep.status).toBe('dry_run')
    expect(rep.wouldImportCount).toBe(1)
    // normalized: (30+20)*308.91 = 15445.5
    expect(rep.plannedLines[0].amount).toBe(15445.5)
    expect(rep.plannedLines[0].confidence).toBe('provider_api')
    expect(rep.dedupKeys).toEqual(['provider|anthropic|anthropic-api|2026-07|provider_api'])
    // sanitized response shape present, types only
    expect(rep.responseShape).not.toBeNull()
    expect((rep.responseShape as any).keys.has_more).toBe('boolean')
  })

  it('does NOT write any provider_api cost_line_item', async () => {
    const db = getDb()
    await dryRunCollector({ db, collector: anthropicCollector, opts: opts(async () => FIXTURE), now: NOW })
    const n = db.prepare("SELECT COUNT(*) n FROM cost_line_items WHERE confidence='provider_api'").get() as { n: number }
    expect(n.n).toBe(0)
    const anyLine = db.prepare('SELECT COUNT(*) n FROM cost_line_items').get() as { n: number }
    expect(anyLine.n).toBe(0)
  })

  it('does NOT write a final import; only a dry_run audit row with count 0', async () => {
    const db = getDb()
    await dryRunCollector({ db, collector: anthropicCollector, opts: opts(async () => FIXTURE), now: NOW })
    const rows = db.prepare('SELECT status, imported_count FROM import_runs').all() as Array<{ status: string; imported_count: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('dry_run')
    expect(rows[0].imported_count).toBe(0)
    // NO 'ok' import ever recorded by a dry-run
    const okRuns = db.prepare("SELECT COUNT(*) n FROM import_runs WHERE status='ok'").get() as { n: number }
    expect(okRuns.n).toBe(0)
  })

  it('recordRun:false persists absolutely nothing', async () => {
    const db = getDb()
    await dryRunCollector({ db, collector: anthropicCollector, opts: opts(async () => FIXTURE), now: NOW, recordRun: false })
    const runs = db.prepare('SELECT COUNT(*) n FROM import_runs').get() as { n: number }
    const lines = db.prepare('SELECT COUNT(*) n FROM cost_line_items').get() as { n: number }
    expect(runs.n).toBe(0)
    expect(lines.n).toBe(0)
  })

  it('on error: status=error, sanitized, writes NO cost line, secret never leaks', async () => {
    const db = getDb()
    const throwing: HttpGetJson = async () => { throw new Error(`rate limited, key ${SECRET} and token abcdef1234567890abcdef1234567890`) }
    const rep = await dryRunCollector({ db, collector: anthropicCollector, opts: opts(throwing), now: NOW })
    expect(rep.status).toBe('error')
    expect(rep.errorMessageSanitized).not.toContain('sk-DRYRUN-must-not-leak')
    expect(rep.wouldImportCount).toBe(0)
    // nothing persisted to cost_line_items
    const lines = db.prepare('SELECT COUNT(*) n FROM cost_line_items').get() as { n: number }
    expect(lines.n).toBe(0)
    // the whole DB + report never contain the secret
    const dump = JSON.stringify(db.prepare('SELECT * FROM import_runs').all()) + JSON.stringify(rep)
    expect(dump).not.toContain('sk-DRYRUN-must-not-leak')
    expect(dump).not.toContain('9876543210')
  })

  it('report + audit row never contain the secret on the happy path', async () => {
    const db = getDb()
    const rep = await dryRunCollector({ db, collector: anthropicCollector, opts: opts(async () => FIXTURE), now: NOW })
    const dump = JSON.stringify(rep) + JSON.stringify(db.prepare('SELECT * FROM import_runs').all())
    expect(dump).not.toContain(SECRET)
    expect(dump).not.toContain('sk-DRYRUN')
  })
})
