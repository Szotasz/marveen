/**
 * Integration tests for hybridSearch() with reranker wiring.
 *
 * Uses real in-memory SQLite. The reranker module is mocked so no ONNX model
 * is needed. Tests verify that hybridSearch() returns valid results regardless
 * of reranker outcome, and that the reranker receives the correct arguments
 * when vector candidates exist and the flag is ON.
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

function make768dBlob(): Buffer {
  const buf = Buffer.allocUnsafe(768 * 4)
  for (let i = 0; i < 768; i++) buf.writeFloatLE(Math.random(), i * 4)
  return buf
}

beforeEach(() => {
  mockRerank.mockClear()
  mockRerank.mockResolvedValue([])
  mockGetEffectiveSettingValue.mockImplementation((_key: string) => '0')
  initDatabase(':memory:')
})

describe('hybridSearch reranker integration', () => {
  it('returns FTS results even when flag is OFF', async () => {
    saveAgentMemory('agent-a', 'apples are tasty red fruit', 'warm', 'apple fruit')
    saveAgentMemory('agent-a', 'bananas are sweet yellow fruit', 'warm', 'banana fruit')

    const results = await hybridSearch('agent-a', 'fruit', 5)

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(m => m.agent_id === 'agent-a')).toBe(true)
    expect(mockRerank).not.toHaveBeenCalled()
  })

  it('calls rerank with correct query when flag is ON and vector candidates exist', async () => {
    const m1 = saveAgentMemory('agent-a', 'machine learning concepts', 'warm', 'ml')
    const m2 = saveAgentMemory('agent-a', 'deep learning neural networks', 'warm', 'dl')

    const { getDb } = await import('../db.js')
    const db = getDb()
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(make768dBlob(), m1.id)
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(make768dBlob(), m2.id)

    const fakeReranked: Memory[] = [
      { id: m2.id, content: 'deep learning neural networks', agent_id: 'agent-a',
        chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1, created_at: 1,
        accessed_at: 1, updated_at: null, category: 'warm', auto_generated: 0,
        keywords: 'dl', embedding: null, embedding_blob: null },
    ]
    mockRerank.mockResolvedValueOnce(fakeReranked)

    mockGetEffectiveSettingValue.mockImplementation((key: string) =>
      key === 'MEMORY_RERANK_ENABLED' ? '1' : '0'
    )

    // Reranker fires on the fused RRF list when flag is ON.
    // Vector path requires generateEmbedding; if Ollama unavailable, FTS-only
    // candidates still trigger the reranker since the fused list is non-empty.
    await hybridSearch('agent-a', 'neural network learning', 2)

    expect(mockRerank).toHaveBeenCalled()
    const [queryArg] = mockRerank.mock.calls[0] as [string, Memory[], unknown]
    expect(queryArg).toBe('neural network learning')
  })

  it('hybridSearch handles reranker throwing gracefully when flag is ON', async () => {
    saveAgentMemory('agent-a', 'content about widgets', 'warm', 'widget')
    mockRerank.mockRejectedValueOnce(new Error('reranker crashed'))

    mockGetEffectiveSettingValue.mockImplementation((key: string) =>
      key === 'MEMORY_RERANK_ENABLED' ? '1' : '0'
    )

    const results = await hybridSearch('agent-a', 'widgets', 5)
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })
})
