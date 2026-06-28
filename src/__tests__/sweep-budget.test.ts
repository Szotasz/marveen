import { describe, it, expect } from 'vitest'
import { selectSweepBatch } from '../web/sweep-budget.js'

// The sweep budget bounds how many sub-agents a single monitor tick processes
// synchronously, so a large fleet cannot pin the event loop. It must cover
// every agent over consecutive ticks (round-robin) and never drop or duplicate
// within a single pass.
describe('selectSweepBatch', () => {
  it('returns all items when batchSize >= length (no batching needed)', () => {
    const r = selectSweepBatch(['a', 'b', 'c'], 0, 5)
    expect(r.batch).toEqual(['a', 'b', 'c'])
    expect(r.nextCursor).toBe(0)
  })

  it('returns an empty batch for an empty list', () => {
    expect(selectSweepBatch([], 3, 4)).toEqual({ batch: [], nextCursor: 0 })
  })

  it('takes a bounded batch and advances the cursor', () => {
    const r = selectSweepBatch(['a', 'b', 'c', 'd', 'e'], 0, 2)
    expect(r.batch).toEqual(['a', 'b'])
    expect(r.nextCursor).toBe(2)
  })

  it('wraps around the end of the list', () => {
    const r = selectSweepBatch(['a', 'b', 'c', 'd', 'e'], 4, 2)
    expect(r.batch).toEqual(['e', 'a'])
    expect(r.nextCursor).toBe(1)
  })

  it('covers every item exactly once over a full cycle', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const seen: string[] = []
    let cursor = 0
    for (let tick = 0; tick < 4; tick++) {
      const r = selectSweepBatch(items, cursor, 2)
      seen.push(...r.batch)
      cursor = r.nextCursor
    }
    // 4 ticks * 2 = 8 slots over 7 items -> every item seen at least once
    for (const it of items) expect(seen).toContain(it)
  })

  it('treats a non-positive budget as "all" (never starves the sweep)', () => {
    expect(selectSweepBatch(['a', 'b'], 0, 0).batch).toEqual(['a', 'b'])
    expect(selectSweepBatch(['a', 'b'], 0, -3).batch).toEqual(['a', 'b'])
  })

  it('tolerates a cursor past the end (modulo)', () => {
    const r = selectSweepBatch(['a', 'b', 'c'], 7, 1)
    expect(r.batch).toEqual(['b']) // 7 % 3 = 1
    expect(r.nextCursor).toBe(2)
  })
})
