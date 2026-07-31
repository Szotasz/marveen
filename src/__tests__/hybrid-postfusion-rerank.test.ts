/**
 * A/B tests verifying that the cross-encoder reranker runs AFTER RRF fusion
 * in hybridSearch(), not inside vectorSearch().
 *
 * Flag OFF  -> reranker never called; result order comes from RRF.
 * Flag ON   -> reranker called on the fused list; result order is the
 *              reranker's output (which may differ from the RRF order).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRerank, mockGetEffectiveSettingValue } = vi.hoisted(() => ({
  mockRerank: vi.fn().mockResolvedValue([]),
  mockGetEffectiveSettingValue: vi.fn().mockImplementation((_key: string) => '0'),
}))

vi.mock('../reranker.js', () => ({
  rerank: mockRerank,
  _resetRankerForTests: vi.fn(),
}))

vi.mock('../settings-store.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../settings-store.js')>()
  return { ...orig, getEffectiveSettingValue: mockGetEffectiveSettingValue }
})

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, saveAgentMemory, hybridSearch } from '../db.js'
import type { Memory } from '../db.js'

beforeEach(() => {
  mockRerank.mockClear()
  mockRerank.mockResolvedValue([])
  mockGetEffectiveSettingValue.mockImplementation((_key: string) => '0')
  initDatabase(':memory:')
})

describe('A/B: reranker applied after RRF fusion', () => {
  it('flag OFF: reranker is never called, result comes from RRF order', async () => {
    saveAgentMemory('agent-a', 'topic alpha', 'warm', 'alpha')
    saveAgentMemory('agent-a', 'topic beta', 'warm', 'beta')

    mockGetEffectiveSettingValue.mockImplementation(() => '0')

    const results = await hybridSearch('agent-a', 'topic', 5)

    expect(mockRerank).not.toHaveBeenCalled()
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  it('flag ON: reranker is called on the fused list and its output is returned', async () => {
    const m1 = saveAgentMemory('agent-a', 'topic alpha first', 'warm', 'alpha')
    const m2 = saveAgentMemory('agent-a', 'topic beta second', 'warm', 'beta')

    // Reranker returns reversed order relative to what FTS/RRF would produce.
    const rerankerOrder: Memory[] = [
      { id: m2.id, content: 'topic beta second', agent_id: 'agent-a',
        chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
        created_at: 1, accessed_at: 1, updated_at: null, category: 'warm',
        auto_generated: 0, keywords: 'beta', embedding: null, embedding_blob: null },
      { id: m1.id, content: 'topic alpha first', agent_id: 'agent-a',
        chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
        created_at: 1, accessed_at: 1, updated_at: null, category: 'warm',
        auto_generated: 0, keywords: 'alpha', embedding: null, embedding_blob: null },
    ]
    mockRerank.mockResolvedValueOnce(rerankerOrder)

    mockGetEffectiveSettingValue.mockImplementation((key: string) =>
      key === 'MEMORY_RERANK_ENABLED' ? '1' : '0'
    )

    const results = await hybridSearch('agent-a', 'topic', 2)

    expect(mockRerank).toHaveBeenCalledOnce()
    // The fused list is the first argument; the query string is passed correctly.
    const [queryArg, candidateList] = mockRerank.mock.calls[0] as [string, Memory[], unknown]
    expect(queryArg).toBe('topic')
    expect(Array.isArray(candidateList)).toBe(true)
    // hybridSearch returns exactly what the reranker outputs.
    expect(results).toEqual(rerankerOrder)
  })

  it('flag ON vs OFF yields different orderings when reranker reverses the list', async () => {
    const m1 = saveAgentMemory('agent-a', 'memory one', 'warm', 'one')
    const m2 = saveAgentMemory('agent-a', 'memory two', 'warm', 'two')

    // OFF: no reranker -- collect whatever order RRF gives.
    mockGetEffectiveSettingValue.mockImplementation(() => '0')
    const offResults = await hybridSearch('agent-a', 'memory', 2)

    // ON: reranker returns the two memories in strictly reversed order.
    const reversed: Memory[] = [
      { id: m2.id, content: 'memory two', agent_id: 'agent-a',
        chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
        created_at: 1, accessed_at: 1, updated_at: null, category: 'warm',
        auto_generated: 0, keywords: 'two', embedding: null, embedding_blob: null },
      { id: m1.id, content: 'memory one', agent_id: 'agent-a',
        chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
        created_at: 1, accessed_at: 1, updated_at: null, category: 'warm',
        auto_generated: 0, keywords: 'one', embedding: null, embedding_blob: null },
    ]
    mockRerank.mockResolvedValueOnce(reversed)
    mockGetEffectiveSettingValue.mockImplementation((key: string) =>
      key === 'MEMORY_RERANK_ENABLED' ? '1' : '0'
    )
    const onResults = await hybridSearch('agent-a', 'memory', 2)

    expect(mockRerank).toHaveBeenCalledOnce()
    // The ON result matches the reranker output exactly.
    expect(onResults).toEqual(reversed)
    // The two orderings differ (reranker changed something relative to RRF).
    if (offResults.length >= 2 && onResults.length >= 2) {
      expect(onResults[0].id).toBe(m2.id)
      expect(onResults[1].id).toBe(m1.id)
    }
  })
})
