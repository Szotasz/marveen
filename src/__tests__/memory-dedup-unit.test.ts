import { describe, it, expect } from 'vitest'
import { findDuplicateMemories } from '../web/memory-dedup.js'

const cand = (id: number, content: string) => ({ id, content, category: 'warm', created_at: id })
const words = (...n: number[]) => n.map((i) => `w${i}`).join(' ')

describe('findDuplicateMemories', () => {
  it('matches an exact repeat after case and whitespace differences', () => {
    const r = findDuplicateMemories('Deploy  is DONE ', [cand(1, 'deploy is done')])
    expect(r).toHaveLength(1)
    expect(r[0].match).toBe('exact')
    expect(r[0].similarity).toBe(1)
  })

  it('treats decomposed and precomposed accents as equal (NFC)', () => {
    const r = findDuplicateMemories('\u00e9 cafe', [cand(1, 'e\u0301 cafe')])
    expect(r[0].match).toBe('exact')
  })

  it('flags similar texts sharing 9 of 10 words', () => {
    const r = findDuplicateMemories(words(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), [cand(1, words(1, 2, 3, 4, 5, 6, 7, 8, 9, 11))])
    expect(r[0].match).toBe('similar')
    expect(r[0].similarity).toBe(0.82)
  })

  it('does not match below the threshold', () => {
    const r = findDuplicateMemories(words(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), [cand(1, words(1, 2, 3, 4, 5, 6, 7, 11, 12, 13))])
    expect(r).toEqual([])
  })

  it('does not treat short texts as similar', () => {
    // 4 of 5 words shared is exactly the 0.8 threshold: only the minimum token
    // count keeps "done" and "not done" apart.
    expect(findDuplicateMemories('the deploy is done', [cand(1, 'the deploy is not done')])).toEqual([])
  })

  it('ignores word order', () => {
    const r = findDuplicateMemories('a1 b2 c3 d4 e5 f6', [cand(1, 'f6 e5 d4 c3 b2 a1')])
    expect(r[0].match).toBe('similar')
    expect(r[0].similarity).toBe(1)
  })

  it('orders exact first, then by similarity, capped at 3', () => {
    const base = words(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    const r = findDuplicateMemories(base, [
      cand(1, base), cand(2, base),
      cand(3, words(1, 2, 3, 4, 5, 6, 7, 8, 9, 11)),
      cand(4, words(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12).replace('w12', 'w10')),
      cand(5, words(1, 2, 3, 4, 5, 6, 7, 8, 9, 12)),
    ])
    expect(r).toHaveLength(3)
    expect(r.map((m) => m.id).slice(0, 2)).toEqual([2, 1])
    expect(r[0].match).toBe('exact')
    expect(r[1].match).toBe('exact')
    expect(r[2].match).toBe('similar')
    // 10 of 11 shared (0.91) beats 9 of 11 (0.82): the most similar one is kept.
    expect(r[2].id).toBe(4)
  })

  it('returns [] for no candidates', () => {
    expect(findDuplicateMemories('anything at all', [])).toEqual([])
  })
})
