import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { tryHandlePrLedger } from '../web/routes/pr-ledger.js'
import type { RouteContext } from '../web/routes/types.js'
// The collector's pure logic -- imported directly, so the decisions the daily
// run makes are the ones under test, not a re-implementation.
// @ts-expect-error plain .mjs module without type declarations
import { mapPr, prNumbersFromMessages, decideLive, isoDay, isGhNotFound, UPSERT_FULL_SQL, UPSERT_PRESERVE_LIVE_SQL } from '../../scripts/pr-ledger-lib.mjs'

const ROOT = join(__dirname, '..', '..')

function fakeGet(pathAndQuery: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return { ctx: { req: {} as any, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

// ---------------------------------------------------------------------------
// Schema parity: db.ts migration == collector's own CREATE (dual-writer
// contract, same as conversation_log / ledger_lib.py). Either side may run
// first; a drift means one writer's column the other never created.
// ---------------------------------------------------------------------------
function ledgerColumns(src: string): string[] {
  const m = src.match(/CREATE TABLE IF NOT EXISTS pr_ledger\s*\(([\s\S]*?)\n\s*\)/)
  if (!m) return []
  return m[1]
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l && !/^(UNIQUE|PRIMARY|FOREIGN|CHECK)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean)
}

describe('pr_ledger schema: db.ts migration == pr-ledger-lib.mjs (no drift)', () => {
  const dbts = readFileSync(join(ROOT, 'src/db.ts'), 'utf-8')
  const lib = readFileSync(join(ROOT, 'scripts/pr-ledger-lib.mjs'), 'utf-8')

  it('both places define the table with identical columns', () => {
    const a = ledgerColumns(dbts).sort()
    const b = ledgerColumns(lib).sort()
    expect(a).toEqual(['additions', 'author', 'base_branch', 'closed_date', 'deletions', 'files', 'is_live', 'live_since', 'measured_at', 'number', 'repo', 'state', 'title'])
    expect(b).toEqual(a)
  })

  it('both carry the natural key UNIQUE(repo, number)', () => {
    expect(dbts).toMatch(/UNIQUE\(repo,\s*number\)/)
    expect(lib).toMatch(/UNIQUE\(repo,\s*number\)/)
  })
})

// ---------------------------------------------------------------------------
// The is_live decision -- the number the whole ledger exists for.
// ---------------------------------------------------------------------------
describe('decideLive', () => {
  const row = (state: string, base: string, number = 42) =>
    ({ state, base_branch: base, number, closed_date: '2026-09-01' }) as any

  it('a merge to main IS the release: live, since its merge day', () => {
    expect(decideLive(row('merged', 'main'), new Set())).toEqual({ is_live: 1, live_since: '2026-09-01' })
    expect(decideLive(row('merged', 'master'), new Set())).toEqual({ is_live: 1, live_since: '2026-09-01' })
  })

  it('a develop merge still sitting in main...develop is NOT live', () => {
    expect(decideLive(row('merged', 'develop', 99), new Set([99])).is_live).toBe(0)
  })

  it('a develop merge NOT in the range shipped with a release: live, but its day is not guessed', () => {
    expect(decideLive(row('merged', 'develop', 99), new Set([100]))).toEqual({ is_live: 1, live_since: null })
  })

  it('a rejected PR is never live, whatever it targeted', () => {
    expect(decideLive(row('closed', 'main'), new Set()).is_live).toBe(0)
    expect(decideLive(row('closed', 'develop'), new Set()).is_live).toBe(0)
  })

  it('a feature-branch merge did not reach the customer', () => {
    expect(decideLive(row('merged', 'feat/something'), new Set()).is_live).toBe(0)
  })
})

describe('collector mapping', () => {
  it('mapPr: merged wins over closed for state and date; missing dates drop the row', () => {
    const merged = mapPr('marveen', { number: 1, mergedAt: '2026-09-01T10:00:00Z', closedAt: '2026-09-01T10:00:00Z', baseRefName: 'develop', author: { login: 'x' }, additions: 1, deletions: 2, changedFiles: 3, title: 't' })
    expect(merged).toMatchObject({ state: 'merged', closed_date: '2026-09-01', base_branch: 'develop', author: 'x' })
    const rejected = mapPr('marveen', { number: 2, mergedAt: null, closedAt: '2026-09-02T10:00:00Z', baseRefName: 'main', title: 't' })
    expect(rejected).toMatchObject({ state: 'closed', closed_date: '2026-09-02' })
    expect(mapPr('marveen', { number: 3, mergedAt: null, closedAt: null })).toBeNull()
  })

  it('prNumbersFromMessages: "(#N)" refs, deduped; noise ignored', () => {
    const set = prNumbersFromMessages(['fix: a (#12)', 'feat: b (#12) and (#34)', 'no ref', 'issue #56 unparenthesised'])
    expect([...set].sort((a, b) => a - b)).toEqual([12, 34])
  })

  it('isoDay: UTC date part only, null on garbage', () => {
    expect(isoDay('2026-09-07T21:00:00Z')).toBe('2026-09-07')
    expect(isoDay(null)).toBeNull()
    expect(isoDay('nonsense')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The read-only endpoint.
// ---------------------------------------------------------------------------
describe('GET /api/pr-ledger', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    const ins = getDb().prepare(`
      INSERT INTO pr_ledger (repo, number, closed_date, base_branch, author, additions, deletions, files, state, title, is_live, live_since, measured_at)
      VALUES (?, ?, ?, ?, 'a', 1, 1, 1, ?, 't', ?, NULL, 0)
    `)
    ins.run('marveen', 1, '2026-08-10', 'develop', 'merged', 1)
    ins.run('marveen', 2, '2026-08-20', 'develop', 'merged', 0)
    ins.run('marveen', 3, '2026-09-07', 'develop', 'closed', 0)
    ins.run('marveen-io', 9, '2026-08-15', 'main', 'merged', 1)
    ins.run('marveen', 4, '2026-07-01', 'develop', 'merged', 1) // window elott
  })

  it('window is inclusive on both ends and the summary matches the rows', async () => {
    const { ctx, out } = fakeGet('/api/pr-ledger?from=2026-08-10&to=2026-09-07')
    expect(await tryHandlePrLedger(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.summary).toEqual({ closed: 4, merged: 3, rejected: 1, live: 2 })
    expect(out.body.rows).toHaveLength(4)
    expect(out.body.rows.map((r: any) => r.number)).toContain(1) // from-nap belefer
  })

  it('repo filter narrows both rows and summary', async () => {
    const { ctx, out } = fakeGet('/api/pr-ledger?from=2026-08-01&to=2026-09-07&repo=marveen-io')
    await tryHandlePrLedger(ctx)
    expect(out.body.summary).toEqual({ closed: 1, merged: 1, rejected: 0, live: 1 })
    expect(out.body.rows[0].repo).toBe('marveen-io')
  })

  it('missing or malformed dates are refused with 400, naming the format', async () => {
    for (const q of ['', '?from=2026-08-01', '?from=aug&to=2026-09-07', '?from=2026-09-07&to=2026-08-01']) {
      const { ctx, out } = fakeGet(`/api/pr-ledger${q}`)
      expect(await tryHandlePrLedger(ctx)).toBe(true)
      expect(out.status).toBe(400)
    }
  })

  it('other methods and paths fall through untouched', async () => {
    const { ctx } = fakeGet('/api/pr-ledger-not-this')
    expect(await tryHandlePrLedger(ctx)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Degraded-mode upsert (Marveen review blocker on #1234): a FAILED unreleased
// measurement must never flip stored develop rows live. The preserve statement
// updates the facts but leaves is_live/live_since untouched; the full one
// overwrites both (that is what makes releases retroactive).
// ---------------------------------------------------------------------------
describe('degraded-mode upsert semantics', () => {
  const base = { repo: 'marveen', closed_date: '2026-09-01', base_branch: 'develop', author: 'a', additions: 1, deletions: 1, files: 1, state: 'merged', title: 'eredeti' }

  beforeEach(() => { initDatabase(':memory:') })

  it('preserve: an existing NOT-live develop row stays not-live, the facts still update', () => {
    getDb().prepare(UPSERT_FULL_SQL).run({ ...base, number: 1, is_live: 0, live_since: null, measured_at: 1 })
    getDb().prepare(UPSERT_PRESERVE_LIVE_SQL).run({ ...base, number: 1, title: 'frissult', measured_at: 2 })
    const r = getDb().prepare('SELECT is_live, live_since, title, measured_at FROM pr_ledger WHERE number = 1').get() as any
    expect(r).toMatchObject({ is_live: 0, live_since: null, title: 'frissult', measured_at: 2 })
  })

  it('preserve: an existing LIVE row keeps is_live=1 and its live_since', () => {
    getDb().prepare(UPSERT_FULL_SQL).run({ ...base, number: 2, is_live: 1, live_since: '2026-08-20', measured_at: 1 })
    getDb().prepare(UPSERT_PRESERVE_LIVE_SQL).run({ ...base, number: 2, measured_at: 2 })
    const r = getDb().prepare('SELECT is_live, live_since FROM pr_ledger WHERE number = 2').get() as any
    expect(r).toEqual({ is_live: 1, live_since: '2026-08-20' })
  })

  it('preserve: a brand-new row enters conservatively as not-live', () => {
    getDb().prepare(UPSERT_PRESERVE_LIVE_SQL).run({ ...base, number: 3, measured_at: 2 })
    const r = getDb().prepare('SELECT is_live, live_since FROM pr_ledger WHERE number = 3').get() as any
    expect(r).toEqual({ is_live: 0, live_since: null })
  })

  it('full: overwrites is_live in both directions (releases are retroactive)', () => {
    getDb().prepare(UPSERT_FULL_SQL).run({ ...base, number: 4, is_live: 0, live_since: null, measured_at: 1 })
    getDb().prepare(UPSERT_FULL_SQL).run({ ...base, number: 4, is_live: 1, live_since: null, measured_at: 2 })
    expect((getDb().prepare('SELECT is_live FROM pr_ledger WHERE number = 4').get() as any).is_live).toBe(1)
  })

  it('isGhNotFound: a clean 404 is the legit no-develop shape, everything else is not', () => {
    expect(isGhNotFound('gh: Not Found (HTTP 404)')).toBe(true)
    expect(isGhNotFound('gh: rate limit exceeded (HTTP 403)')).toBe(false)
    expect(isGhNotFound('connect ETIMEDOUT')).toBe(false)
    expect(isGhNotFound(null)).toBe(false)
  })
})
