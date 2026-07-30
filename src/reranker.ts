import { pipeline, type TextClassificationPipeline } from '@huggingface/transformers'
import { logger } from './logger.js'
import type { Memory } from './db.js'

// ms-marco-MiniLM-L-6-v2: 23 MB q8 ONNX cross-encoder. Scores (query, passage)
// pairs for relevance. ~100-300 ms CPU latency per batch. Lazy singleton.
const RERANKER_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'

let rankerInstance: TextClassificationPipeline | null = null
let loadPromise: Promise<TextClassificationPipeline> | null = null

async function getRanker(): Promise<TextClassificationPipeline> {
  if (rankerInstance) return rankerInstance
  if (!loadPromise) {
    loadPromise = (pipeline('text-classification', RERANKER_MODEL, { dtype: 'q8' }) as Promise<TextClassificationPipeline>).then(p => {
      rankerInstance = p
      return p
    }).catch(err => {
      loadPromise = null
      throw err
    })
  }
  return loadPromise
}

export interface RerankOptions {
  topK?: number
  maxCandidates?: number
}

/**
 * Re-ranks candidate memories by relevance to query using a cross-encoder.
 *
 * Passes (query, passage) pairs through the model and sorts by score descending.
 * Falls back to original order if model is unavailable or inference fails.
 */
export async function rerank(
  query: string,
  candidates: Memory[],
  opts: RerankOptions = {}
): Promise<Memory[]> {
  const { topK = candidates.length, maxCandidates = candidates.length } = opts
  const pool = candidates.slice(0, maxCandidates)
  if (pool.length === 0) return []

  try {
    const ranker = await getRanker()
    // Cross-encoder expects {text: query, text_pair: passage} inputs.
    const inputs = pool.map(m => ({ text: query, text_pair: m.content }))
    const raw = await ranker(inputs as unknown as Parameters<typeof ranker>[0]) as { score: number; label: string }[]

    return pool
      .map((m, i) => ({ memory: m, score: raw[i]?.score ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(r => r.memory)
  } catch (err) {
    logger.debug({ err, model: RERANKER_MODEL }, 'Cross-encoder rerank failed, keeping original order')
    return pool.slice(0, topK)
  }
}

// Exposed for testing only -- allows resetting the singleton between tests.
export function _resetRankerForTests(): void {
  rankerInstance = null
  loadPromise = null
}
