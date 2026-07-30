/**
 * Cross-encoder reranker unit tests.
 *
 * The @huggingface/transformers pipeline is mocked throughout -- the model
 * binary is not downloaded in CI. Tests verify ordering logic, fallback
 * behaviour, and the lazy singleton lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Must be hoisted: vi.mock() is hoisted before imports, so variables used
// inside the factory must be created with vi.hoisted().
const { mockPipeline, mockRankerFn } = vi.hoisted(() => {
  const mockRankerFn = vi.fn()
  const mockPipeline = vi.fn().mockResolvedValue(mockRankerFn)
  return { mockPipeline, mockRankerFn }
})

vi.mock('@huggingface/transformers', () => ({
  pipeline: mockPipeline,
}))

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { rerank, _resetRankerForTests } from '../reranker.js'
import type { Memory } from '../db.js'

function makeMemory(id: number, content: string): Memory {
  return {
    id,
    chat_id: 'chat-1',
    topic_key: null,
    content,
    sector: 'semantic',
    salience: 1.0,
    created_at: 1750000000,
    accessed_at: 1750000001,
    updated_at: null,
    agent_id: 'agent-a',
    category: 'warm',
    auto_generated: 0,
    keywords: null,
    embedding: null,
    embedding_blob: null,
  }
}

beforeEach(() => {
  _resetRankerForTests()
  mockPipeline.mockClear()
  mockRankerFn.mockClear()
})

describe('rerank()', () => {
  it('returns empty array for empty candidates', async () => {
    const result = await rerank('query', [])
    expect(result).toEqual([])
    expect(mockPipeline).not.toHaveBeenCalled()
  })

  it('loads model lazily on first call', async () => {
    const m = makeMemory(1, 'hello')
    mockRankerFn.mockResolvedValueOnce([{ label: 'LABEL_0', score: 0.8 }])
    await rerank('query', [m])
    expect(mockPipeline).toHaveBeenCalledOnce()
    expect(mockPipeline).toHaveBeenCalledWith('text-classification', expect.any(String), expect.objectContaining({ dtype: 'q8' }))
  })

  it('reuses the same pipeline instance on subsequent calls', async () => {
    const m = makeMemory(1, 'hello')
    mockRankerFn.mockResolvedValue([{ label: 'LABEL_0', score: 0.5 }])
    await rerank('q', [m])
    await rerank('q', [m])
    expect(mockPipeline).toHaveBeenCalledOnce()
  })

  it('sorts candidates by descending score', async () => {
    const candidates = [
      makeMemory(1, 'low relevance'),
      makeMemory(2, 'high relevance'),
      makeMemory(3, 'mid relevance'),
    ]
    mockRankerFn.mockResolvedValueOnce([
      { label: 'LABEL_0', score: 0.1 },
      { label: 'LABEL_0', score: 0.9 },
      { label: 'LABEL_0', score: 0.5 },
    ])
    const result = await rerank('query', candidates)
    expect(result.map(m => m.id)).toEqual([2, 3, 1])
  })

  it('respects topK option', async () => {
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b'), makeMemory(3, 'c')]
    mockRankerFn.mockResolvedValueOnce([
      { label: 'LABEL_0', score: 0.3 },
      { label: 'LABEL_0', score: 0.9 },
      { label: 'LABEL_0', score: 0.6 },
    ])
    const result = await rerank('query', candidates, { topK: 2 })
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe(2)
    expect(result[1].id).toBe(3)
  })

  it('respects maxCandidates option (truncates pool before scoring)', async () => {
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b'), makeMemory(3, 'c')]
    mockRankerFn.mockResolvedValueOnce([
      { label: 'LABEL_0', score: 0.8 },
      { label: 'LABEL_0', score: 0.2 },
    ])
    const result = await rerank('query', candidates, { maxCandidates: 2 })
    // Only first 2 candidates were passed to model
    const inputArg = mockRankerFn.mock.calls[0][0] as { text: string; text_pair: string }[]
    expect(inputArg).toHaveLength(2)
    expect(result).toHaveLength(2)
  })

  it('passes query+passage pairs as {text, text_pair} to the model', async () => {
    const candidates = [makeMemory(1, 'passage text')]
    mockRankerFn.mockResolvedValueOnce([{ label: 'LABEL_0', score: 0.7 }])
    await rerank('my query', candidates)
    const inputArg = mockRankerFn.mock.calls[0][0] as { text: string; text_pair: string }[]
    expect(inputArg[0]).toEqual({ text: 'my query', text_pair: 'passage text' })
  })

  it('falls back to original order when model load fails', async () => {
    mockPipeline.mockRejectedValueOnce(new Error('model not found'))
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b')]
    const result = await rerank('query', candidates)
    expect(result.map(m => m.id)).toEqual([1, 2])
  })

  it('falls back to original order when inference throws', async () => {
    mockRankerFn.mockRejectedValueOnce(new Error('ONNX runtime error'))
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b')]
    const result = await rerank('query', candidates)
    expect(result.map(m => m.id)).toEqual([1, 2])
  })

  it('handles missing score in model output gracefully (treats as 0)', async () => {
    const candidates = [makeMemory(1, 'good'), makeMemory(2, 'better')]
    mockRankerFn.mockResolvedValueOnce([
      { label: 'LABEL_0', score: 0.9 },
      undefined,
    ])
    const result = await rerank('query', candidates)
    // id=1 has score 0.9; id=2 gets score 0 -> id=1 first
    expect(result[0].id).toBe(1)
  })
})
