import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'
import { logger } from './logger.js'
import type { Memory } from './db.js'

// bge-reranker-base (Xenova ONNX): ~180 MB q8, mBERT base (104 languages incl. hu).
// Scores (query, passage) pairs for relevance. ~150-400 ms CPU latency per batch.
// Lazy singleton. Xenova conversion provides the onnx/ folder needed by transformers.js.
const RERANKER_MODEL = 'Xenova/bge-reranker-base'

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>
type Model = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>

let tokenizerInstance: Tokenizer | null = null
let modelInstance: Model | null = null
let loadPromise: Promise<void> | null = null

async function getRanker(): Promise<{ tokenizer: Tokenizer; model: Model }> {
  if (tokenizerInstance && modelInstance) return { tokenizer: tokenizerInstance, model: modelInstance }
  if (!loadPromise) {
    loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(RERANKER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, { dtype: 'q8' }),
    ]).then(([tok, mod]) => {
      tokenizerInstance = tok as Tokenizer
      modelInstance = mod as Model
    }).catch(err => {
      loadPromise = null
      throw err
    })
  }
  await loadPromise
  return { tokenizer: tokenizerInstance!, model: modelInstance! }
}

export interface RerankOptions {
  topK?: number
  maxCandidates?: number
}

/**
 * Re-ranks candidate memories by relevance to query using a cross-encoder.
 *
 * Uses AutoTokenizer + AutoModelForSequenceClassification directly so that
 * (query, passage) pairs are tokenized as [CLS] query [SEP] passage [SEP]
 * sequences. The single output logit per pair is passed through sigmoid to
 * produce a 0..1 relevance score, then candidates are sorted descending.
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
    const { tokenizer, model } = await getRanker()

    // Encode each (query, passage) pair: [CLS] query [SEP] passage [SEP]
    // The text_pair array route is the only correct way to get sentence-pair
    // tokenization from transformers.js -- passing {text, text_pair} objects
    // to a pipeline._call() does NOT work (it expects flat strings).
    const queries = pool.map(() => query)
    const passages = pool.map(m => m.content)
    const inputs = tokenizer(queries, { text_pair: passages, padding: true, truncation: true })

    const outputs = await (model as (inputs: unknown) => Promise<{ logits: { tolist(): number[][] } }>)(inputs)
    // logits shape: [batch_size, 1] -- one relevance logit per (query, passage) pair
    const logitRows = outputs.logits.tolist()
    const scores = logitRows.map(row => 1 / (1 + Math.exp(-(row[0] ?? 0))))

    return pool
      .map((m, i) => ({ memory: m, score: scores[i] ?? 0 }))
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
  tokenizerInstance = null
  modelInstance = null
  loadPromise = null
}
