import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  TOKEN_PRUNE_OLDEST_SQL,
  TOKEN_PRUNE_TOLERANCE_CYCLES,
  DECAY_SWEEP_INTERVAL_MS,
  classifyTokenPruneLag,
} from '../db.js'

// HBDBKUSZOB823. The heartbeat carried a `dbSize > 100 MB` warning; measured
// 2026-09-13 the DB is 481.7 MB and ~65 % of it is the token ledger, which the
// daily sweep holds at exactly the retention. The size is bounded BY DESIGN,
// so that alarm can never go quiet -- and the failure it claimed to watch (the
// prune silently stopping) is invisible to it, because "the DB is big" is
// already permanently true. This replaces it with a signal that CAN be quiet.
//
// The number that shaped these fixtures, measured on the live DB the same day:
// 50 rows sat past the 90-day cutoff, the oldest overshooting by 16.4 MINUTES.
// That is not a prune failure, it is rows aging since the last sweep -- so the
// naive "oldest row older than retention" test would be true almost always.

const RETENTION = 90
const TOLERANCE_H = (TOKEN_PRUNE_TOLERANCE_CYCLES * DECAY_SWEEP_INTERVAL_MS) / 3_600_000
const NOW = 1_789_000_000 // fixed clock: the classifier takes `now`, so no skew
const cutoff = (overshootHours: number) => NOW - RETENTION * 86400 - Math.round(overshootHours * 3600)

describe('TOKEN_PRUNE_OLDEST_SQL (the shipped statement, on a fixture DB)', () => {
  function fixtureDb() {
    const dir = mkdtempSync(join(tmpdir(), 'token-prune-'))
    const db = new Database(join(dir, 'test.db'))
    db.exec('CREATE TABLE token_usage (id INTEGER PRIMARY KEY, timestamp INTEGER)')
    return db
  }

  it('returns the oldest timestamp, not the newest', () => {
    const db = fixtureDb()
    const ins = db.prepare('INSERT INTO token_usage (timestamp) VALUES (?)')
    ins.run(NOW - 500); ins.run(NOW - 90_000); ins.run(NOW - 42)
    expect((db.prepare(TOKEN_PRUNE_OLDEST_SQL).get() as { oldest: number }).oldest).toBe(NOW - 90_000)
  })

  it('returns null on an empty table -- never 0, which would read as 1970', () => {
    const db = fixtureDb()
    expect((db.prepare(TOKEN_PRUNE_OLDEST_SQL).get() as { oldest: number | null }).oldest).toBeNull()
  })
})

describe('classifyTokenPruneLag: the verdict', () => {
  it('NEGATIVE CONTROL -- the real live shape (16.4 min past the cutoff) is quiet', () => {
    const r = classifyTokenPruneLag(cutoff(16.4 / 60), RETENTION, NOW, TOLERANCE_H)
    expect(r.state).toBe('ok')
  })

  it('MUTATION CONTROL -- with a zero tolerance that SAME input fires', () => {
    // If this did not diverge, the fixture above would be pinning a constant
    // rather than measuring the tolerance, and the naive rule would look
    // indistinguishable from the shipped one.
    const naive = classifyTokenPruneLag(cutoff(16.4 / 60), RETENTION, NOW, 0)
    const shipped = classifyTokenPruneLag(cutoff(16.4 / 60), RETENTION, NOW, TOLERANCE_H)
    expect(naive.state).toBe('stale')
    expect(naive.state).not.toBe(shipped.state)
  })

  it('POSITIVE CONTROL -- a row past the tolerance fires', () => {
    const r = classifyTokenPruneLag(cutoff(TOLERANCE_H + 1), RETENTION, NOW, TOLERANCE_H)
    expect(r.state).toBe('stale')
    expect(r.lag_hours).toBeGreaterThan(TOLERANCE_H)
  })

  it('the boundary is strict: exactly at the tolerance is still ok, just past is stale', () => {
    expect(classifyTokenPruneLag(cutoff(TOLERANCE_H), RETENTION, NOW, TOLERANCE_H).state).toBe('ok')
    expect(classifyTokenPruneLag(cutoff(TOLERANCE_H + 0.02), RETENTION, NOW, TOLERANCE_H).state).toBe('stale')
  })

  it('a fresh sweep (nothing aged past the cutoff yet) is ok, not a finding', () => {
    const r = classifyTokenPruneLag(cutoff(-5), RETENTION, NOW, TOLERANCE_H)
    expect(r.state).toBe('ok')
    expect(r.lag_hours).toBeLessThan(0)
  })

  it('an empty table is its OWN state -- neither healthy nor broken', () => {
    const r = classifyTokenPruneLag(null, RETENTION, NOW, TOLERANCE_H)
    expect(r.state).toBe('empty')
    expect(r.lag_hours).toBeNull()
    expect(r.oldest_age_days).toBeNull()
  })

  it('the lag IS the time since the last sweep (that is what makes it readable)', () => {
    const r = classifyTokenPruneLag(cutoff(30), RETENTION, NOW, TOLERANCE_H)
    expect(r.lag_hours).toBeCloseTo(30, 1)
  })

  it('the tolerance is two REAL sweep cycles, derived from the interval', () => {
    // Pins the relation, not the number: if the sweep cadence changes, the
    // tolerance follows instead of silently becoming wrong.
    expect(TOLERANCE_H).toBe((2 * DECAY_SWEEP_INTERVAL_MS) / 3_600_000)
    expect(TOLERANCE_H).toBe(48)
  })

  it('a longer retention moves the cutoff, not the verdict logic', () => {
    const oldest = NOW - 200 * 86400
    expect(classifyTokenPruneLag(oldest, 90, NOW, TOLERANCE_H).state).toBe('stale')
    expect(classifyTokenPruneLag(oldest, 365, NOW, TOLERANCE_H).state).toBe('ok')
  })
})
