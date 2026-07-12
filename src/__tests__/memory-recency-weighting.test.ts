import { describe, it, expect, beforeAll } from 'vitest'
import {
  initDatabase,
  saveAgentMemory,
  searchAgentMemories,
  recencyWeightedScore,
  reRankByRecency,
  getDb,
  RECENCY_TAU_SEC,
} from '../db.js'

// Recency-weighted retrieval (Roitman 17.4.2): score = λ·relevance + (1−λ)·exp(−age/τ).
// Pure-function tests pin the blend semantics; the integration test proves the
// tie-break end-to-end through FTS5 on a real (in-memory) database.

const DAY = 86400

describe('recencyWeightedScore / reRankByRecency (pure)', () => {
  const now = 1_800_000_000

  it('holtverseny: azonos relevancia mellett a frissebb memória nyer', () => {
    const older = { rank: -2.0, created_at: now - 30 * DAY }
    const newer = { rank: -2.0, created_at: now - 1 * DAY }
    expect(recencyWeightedScore(newer, now)).toBeGreaterThan(recencyWeightedScore(older, now))
    const ranked = reRankByRecency([older, newer], 2, now)
    expect(ranked[0]).toBe(newer)
    expect(ranked[1]).toBe(older)
  })

  it('erős relevancia-különbség legyőzi a frissességet (λ = 0.7 dominancia)', () => {
    // Strong match from a month ago vs a barely-matching memory from today.
    const strongOld = { rank: -8.0, created_at: now - 30 * DAY }
    const weakNew = { rank: -0.1, created_at: now }
    const ranked = reRankByRecency([weakNew, strongOld], 2, now)
    expect(ranked[0]).toBe(strongOld)
  })

  it('nem-negatív bm25 rank relevanciája 0 (degenerált eset, nem dob hibát)', () => {
    const row = { rank: 0, created_at: now }
    // Only the recency term remains: (1−λ)·exp(0) = 0.3
    expect(recencyWeightedScore(row, now)).toBeCloseTo(0.3, 10)
  })

  it('a jövőbeli created_at nem kap 1-nél nagyobb recency-t (age clamp 0-ra)', () => {
    const future = { rank: -1.0, created_at: now + 10 * DAY }
    const present = { rank: -1.0, created_at: now }
    expect(recencyWeightedScore(future, now)).toBeCloseTo(recencyWeightedScore(present, now), 10)
  })

  it('limitre vág és a sorrend determinisztikus', () => {
    const rows = [
      { rank: -1.0, created_at: now - 10 * DAY },
      { rank: -1.0, created_at: now - 5 * DAY },
      { rank: -1.0, created_at: now - 1 * DAY },
    ]
    const ranked = reRankByRecency(rows, 2, now)
    expect(ranked).toHaveLength(2)
    expect(ranked[0].created_at).toBe(now - 1 * DAY)
    expect(ranked[1].created_at).toBe(now - 5 * DAY)
  })

  it('tau: az exponens időállandója szerint cseng le a recency', () => {
    const atTau = { rank: 0, created_at: now - RECENCY_TAU_SEC }
    // (1−λ)·exp(−1) = 0.3·0.3679
    expect(recencyWeightedScore(atTau, now)).toBeCloseTo(0.3 * Math.exp(-1), 10)
  })
})

describe('searchAgentMemories recency tie-break (integration, in-memory FTS5)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
  })

  it('azonos kulcsszavú régi és új memóriából az új jön előrébb', () => {
    const now = Math.floor(Date.now() / 1000)
    // Same content shape -> near-identical bm25; only the age differs.
    const oldId = saveAgentMemory('tester', 'A dizel generátor állapota: LEÁLLT tegnap óta.', 'hot', 'generátor, státusz').id
    const newId = saveAgentMemory('tester', 'A dizel generátor állapota: ÚJRA MŰKÖDIK mostantól.', 'hot', 'generátor, státusz').id
    // Backdate the first memory by 30 days directly in the DB.
    getDb().prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(now - 30 * DAY, oldId)

    const results = searchAgentMemories('tester', 'generátor állapota', 5)
    const ids = results.map((m) => m.id)
    expect(ids).toContain(oldId)
    expect(ids).toContain(newId)
    expect(ids.indexOf(newId)).toBeLessThan(ids.indexOf(oldId))
    // The public shape must not leak the internal FTS rank column.
    expect('rank' in results[0]).toBe(false)
  })
})
