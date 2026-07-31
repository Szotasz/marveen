/**
 * Integration test for the multilingual cross-encoder reranker.
 *
 * Downloads and runs the REAL model (jinaai/jina-reranker-v2-base-multilingual,
 * ~278 MB q8 ONNX). Skipped in normal CI because it requires network access and
 * a warm model cache (~200-500 ms per batch after first load).
 *
 * Enable with:  INTEGRATION_TEST=1 npx vitest run src/__tests__/reranker-multilingual-integration.test.ts
 *
 * These tests exist to catch the class of bug where mocked unit tests pass but
 * the real model produces wrong output (e.g. constant scores due to incorrect
 * sentence-pair encoding, or a monolingual model failing on Hungarian text).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { rerank, _resetRankerForTests } from '../reranker.js'
import type { Memory } from '../db.js'

const RUN = !!process.env.INTEGRATION_TEST

function mem(id: number, content: string, keywords: string): Memory {
  return {
    id,
    content,
    keywords,
    agent_id: 'agent-a',
    chat_id: 'c',
    topic_key: null,
    sector: 'semantic',
    salience: 1,
    created_at: 1_700_000_000,
    accessed_at: 1_700_000_000,
    updated_at: null,
    category: 'warm',
    auto_generated: 0,
    embedding: null,
    embedding_blob: null,
  }
}

beforeAll(() => {
  if (!RUN) return
  _resetRankerForTests()
})

describe.skipIf(!RUN)('reranker-multilingual integration (real model, INTEGRATION_TEST=1 required)', () => {
  it('ranks relevant Hungarian passage above irrelevant Hungarian passage', async () => {
    const relevant = mem(1, 'A Duna Magyarország leghosszabb folyója, amely Budapesten folyik át.', 'duna folyó budapest')
    const irrelevant = mem(2, 'A könyvelési szoftverek automatizálják a bérszámfejtést és az áfa-bevallást.', 'könyvelés szoftver bérszámfejtés')

    // irrelevant is first in input -- model must flip the order
    const results = await rerank('melyik folyó folyik át Budapesten?', [irrelevant, relevant], { topK: 2 })

    expect(results).toHaveLength(2)
    expect(results[0].id).toBe(1)   // relevant ranked first
    expect(results[1].id).toBe(2)
  }, 120_000)

  it('returns distinct scores for two semantically different passages', async () => {
    const onTopic = mem(3, 'Budapest főváros több mint 1,7 millió lakossal rendelkezik.', 'budapest főváros lakos')
    const offTopic = mem(4, 'Az alma és a körte a leggyakoribb gyümölcsök a hazai piacokon.', 'alma körte gyümölcs piac')

    const results = await rerank('Magyarország fővárosa', [onTopic, offTopic], { topK: 2 })

    expect(results[0].id).toBe(3)   // on-topic passage ranked first
  }, 60_000)
})
