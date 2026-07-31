/**
 * Cross-encoder reranker unit tests.
 *
 * AutoTokenizer and AutoModelForSequenceClassification are mocked -- no ONNX
 * binary is downloaded in CI. Tests verify:
 *   - tokenizer is called with (queries[], { text_pair: passages[] }) so each
 *     pair is properly encoded as [CLS] query [SEP] passage [SEP]
 *   - model logits are passed through sigmoid and sorted descending
 *   - fallback behaviour on load/inference failure
 *   - lazy singleton lifecycle
 *   - functional: relevant passage (high logit) ranks above irrelevant (low logit)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockTokenizerFn, mockModelFn, mockFromPretrainedTokenizer, mockFromPretrainedModel } = vi.hoisted(() => {
  const mockTokenizerFn = vi.fn().mockReturnValue({ input_ids: [], attention_mask: [] })
  const mockModelFn = vi.fn().mockResolvedValue({ logits: { tolist: () => [] as number[][] } })
  const mockFromPretrainedTokenizer = vi.fn().mockResolvedValue(mockTokenizerFn)
  const mockFromPretrainedModel = vi.fn().mockResolvedValue(mockModelFn)
  return { mockTokenizerFn, mockModelFn, mockFromPretrainedTokenizer, mockFromPretrainedModel }
})

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: mockFromPretrainedTokenizer },
  AutoModelForSequenceClassification: { from_pretrained: mockFromPretrainedModel },
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
  mockFromPretrainedTokenizer.mockClear()
  mockFromPretrainedModel.mockClear()
  mockTokenizerFn.mockClear()
  mockModelFn.mockClear()
  mockTokenizerFn.mockReturnValue({ input_ids: [], attention_mask: [] })
  mockModelFn.mockResolvedValue({ logits: { tolist: () => [] as number[][] } })
})

describe('rerank()', () => {
  it('returns empty array for empty candidates', async () => {
    const result = await rerank('query', [])
    expect(result).toEqual([])
    expect(mockFromPretrainedTokenizer).not.toHaveBeenCalled()
    expect(mockFromPretrainedModel).not.toHaveBeenCalled()
  })

  it('loads tokenizer and model lazily on first call', async () => {
    const m = makeMemory(1, 'hello')
    mockModelFn.mockResolvedValueOnce({ logits: { tolist: () => [[0.5]] } })
    await rerank('query', [m])
    expect(mockFromPretrainedTokenizer).toHaveBeenCalledOnce()
    expect(mockFromPretrainedModel).toHaveBeenCalledOnce()
    expect(mockFromPretrainedModel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ dtype: 'q8' })
    )
  })

  it('reuses the same tokenizer and model instance on subsequent calls', async () => {
    const m = makeMemory(1, 'hello')
    mockModelFn.mockResolvedValue({ logits: { tolist: () => [[0.5]] } })
    await rerank('q', [m])
    await rerank('q', [m])
    expect(mockFromPretrainedTokenizer).toHaveBeenCalledOnce()
    expect(mockFromPretrainedModel).toHaveBeenCalledOnce()
  })

  it('passes separate query and passage arrays to tokenizer (sentence-pair encoding)', async () => {
    const candidates = [makeMemory(1, 'first passage'), makeMemory(2, 'second passage')]
    mockModelFn.mockResolvedValueOnce({ logits: { tolist: () => [[0.5], [0.3]] } })
    await rerank('my query', candidates)

    expect(mockTokenizerFn).toHaveBeenCalledOnce()
    const [queriesArg, options] = mockTokenizerFn.mock.calls[0] as [string[], { text_pair: string[]; padding: boolean; truncation: boolean }]
    expect(queriesArg).toEqual(['my query', 'my query'])
    expect(options.text_pair).toEqual(['first passage', 'second passage'])
    expect(options.padding).toBe(true)
    expect(options.truncation).toBe(true)
  })

  it('sorts candidates by descending sigmoid(logit) score', async () => {
    const candidates = [
      makeMemory(1, 'low relevance'),   // logit -2 -> sigmoid ~0.12
      makeMemory(2, 'high relevance'),  // logit  3 -> sigmoid ~0.95
      makeMemory(3, 'mid relevance'),   // logit  0 -> sigmoid  0.50
    ]
    mockModelFn.mockResolvedValueOnce({ logits: { tolist: () => [[-2.0], [3.0], [0.0]] } })
    const result = await rerank('query', candidates)
    expect(result.map(m => m.id)).toEqual([2, 3, 1])
  })

  it('respects topK option', async () => {
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b'), makeMemory(3, 'c')]
    mockModelFn.mockResolvedValueOnce({ logits: { tolist: () => [[0.3], [0.9], [0.6]] } })
    const result = await rerank('query', candidates, { topK: 2 })
    expect(result).toHaveLength(2)
    // sigmoid(0.9) > sigmoid(0.6) > sigmoid(0.3)
    expect(result[0].id).toBe(2)
    expect(result[1].id).toBe(3)
  })

  it('respects maxCandidates option (truncates pool before scoring)', async () => {
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b'), makeMemory(3, 'c')]
    mockModelFn.mockResolvedValueOnce({ logits: { tolist: () => [[0.8], [0.2]] } })
    const result = await rerank('query', candidates, { maxCandidates: 2 })
    // Only first 2 candidates were passed to tokenizer
    const [queriesArg] = mockTokenizerFn.mock.calls[0] as [string[]]
    expect(queriesArg).toHaveLength(2)
    expect(result).toHaveLength(2)
  })

  it('falls back to original order when model load fails', async () => {
    mockFromPretrainedModel.mockRejectedValueOnce(new Error('model not found'))
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b')]
    const result = await rerank('query', candidates)
    expect(result.map(m => m.id)).toEqual([1, 2])
  })

  it('falls back to original order when inference throws', async () => {
    mockModelFn.mockRejectedValueOnce(new Error('ONNX runtime error'))
    const candidates = [makeMemory(1, 'a'), makeMemory(2, 'b')]
    const result = await rerank('query', candidates)
    expect(result.map(m => m.id)).toEqual([1, 2])
  })

  it('treats missing logit row as score 0', async () => {
    const candidates = [makeMemory(1, 'good'), makeMemory(2, 'better')]
    // Only one logit row returned despite two candidates -- second gets score 0
    mockModelFn.mockResolvedValueOnce({ logits: { tolist: () => [[3.0]] } })
    const result = await rerank('query', candidates)
    // id=1 has sigmoid(3)~0.95; id=2 gets 0 -> id=1 first
    expect(result[0].id).toBe(1)
  })
})

describe('functional: high-logit passage ranks above low-logit passage', () => {
  it('relevant passage (high logit) is ranked first regardless of input order', async () => {
    const relevant = makeMemory(1, 'the answer to the question')
    const irrelevant = makeMemory(2, 'unrelated topic about weather')

    // Simulate model assigning high logit to relevant, low to irrelevant
    mockModelFn.mockResolvedValueOnce({
      logits: { tolist: () => [[4.5], [-3.0]] },
    })

    const result = await rerank('what is the answer?', [relevant, irrelevant])

    // Verify sentence-pair encoding: tokenizer received arrays, not {text, text_pair} objects
    const [queriesArg, options] = mockTokenizerFn.mock.calls[0] as [string[], { text_pair: string[] }]
    expect(Array.isArray(queriesArg)).toBe(true)
    expect(Array.isArray(options.text_pair)).toBe(true)
    expect(queriesArg[0]).toBe('what is the answer?')
    expect(options.text_pair[0]).toBe('the answer to the question')
    expect(options.text_pair[1]).toBe('unrelated topic about weather')

    // High-logit passage must come first
    expect(result[0].id).toBe(1)
    expect(result[1].id).toBe(2)
  })

  it('model output order overrides input order when logits differ', async () => {
    const first = makeMemory(10, 'passage A')
    const second = makeMemory(20, 'passage B')

    // Model says second passage is more relevant
    mockModelFn.mockResolvedValueOnce({
      logits: { tolist: () => [[-1.0], [5.0]] },
    })

    const result = await rerank('test query', [first, second])
    expect(result[0].id).toBe(20)
    expect(result[1].id).toBe(10)
  })
})
