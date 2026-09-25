import { describe, it, expect, beforeAll } from 'vitest'
import { buildFtsMatchExpression, initDatabase, saveAgentMemory, searchAgentMemories, getDb } from '../db.js'

// GH #1025: joining tokens with a space is an implicit AND in FTS5, so every
// word of a question had to appear in a memory. The reporter measured
// "meddig tart a felmondasi ido" returning 0 rows while "felmondasi ido"
// returned the correct memory at rank 1, because no memory contains "meddig".
describe('buildFtsMatchExpression', () => {
  it('still ANDs by default, so today working queries keep their precision', () => {
    expect(buildFtsMatchExpression('felmondasi ido')).toBe('felmondasi* ido*')
  })

  it('produces an explicit OR expression when asked for the relaxed pass', () => {
    expect(buildFtsMatchExpression('felmondasi ido', 'OR')).toBe('felmondasi* OR ido*')
  })

  it('relaxes every token of a naturally phrased question', () => {
    expect(buildFtsMatchExpression('meddig tart a felmondasi ido', 'OR'))
      .toBe('meddig* OR tart* OR a* OR felmondasi* OR ido*')
  })

  it('gives a single token query the same expression either way, so no second pass runs', () => {
    expect(buildFtsMatchExpression('felmondas', 'OR')).toBe(buildFtsMatchExpression('felmondas'))
  })

  it('returns an empty expression for a query with no usable tokens', () => {
    expect(buildFtsMatchExpression('   ')).toBe('')
    expect(buildFtsMatchExpression('!!! ???', 'OR')).toBe('')
  })

  it('keeps punctuation splitting identical in both modes', () => {
    expect(buildFtsMatchExpression('rank-check serper.dev', 'OR'))
      .toBe('rank* OR check* OR serper* OR dev*')
  })
})

describe('searchAgentMemories AND-then-OR fallback (integration, in-memory FTS5)', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
    saveAgentMemory('tester', 'Antal felmondasi ideje harom honap, a szerzodes 12. pontja szerint.', 'warm', 'felmondas, szerzodes')
    saveAgentMemory('tester', 'A parkolobérlet havi dija 18000 forint.', 'warm', 'parkolas')
  })

  it('the strict AND pass finds nothing for the naturally phrased question', () => {
    // The exact shape reported: no memory contains the word "meddig".
    const strict = buildFtsMatchExpression('meddig tart a felmondasi ido')
    const rows = getDb().prepare(
      `SELECT m.id FROM memories m JOIN memories_fts f ON m.id = f.rowid
       WHERE f.memories_fts MATCH ? AND m.agent_id = ?`
    ).all(strict, 'tester')
    expect(rows).toHaveLength(0)
  })

  it('the search answers the same question, because it retries with OR', () => {
    const results = searchAgentMemories('tester', 'meddig tart a felmondasi ido', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain('felmondasi ideje')
  })

  it('reports that it had to relax, so a caller can tell a strict hit from a rescued one', () => {
    const relaxedTrace = { relaxed: false }
    searchAgentMemories('tester', 'meddig tart a felmondasi ido', 5, relaxedTrace)
    expect(relaxedTrace.relaxed).toBe(true)

    const strictTrace = { relaxed: false }
    const strictHits = searchAgentMemories('tester', 'felmondasi ideje', 5, strictTrace)
    expect(strictHits.length).toBeGreaterThan(0)
    expect(strictTrace.relaxed).toBe(false)
  })

  it('does not relax when AND already has an answer, so precision is unchanged', () => {
    const results = searchAgentMemories('tester', 'parkolobérlet havi dija', 5)
    expect(results).toHaveLength(1)
    expect(results[0].content).toContain('parkolobérlet')
  })
})
