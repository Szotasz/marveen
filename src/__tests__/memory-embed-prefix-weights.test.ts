// Embedding task prefixes, the embedder's keep_alive, and per-branch fusion
// weights in hybrid search -- all settings, all off by default.
//
// Some embedding models are trained with task prefixes (a query and a stored
// document are embedded differently) and retrieve worse without them; the
// settings let an install use them. With nothing set, the request and the
// ranking are exactly what they were.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const settingValues: Record<string, string> = {}
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key in settingValues ? settingValues[key] : actual.getEffectiveSettingValue(key),
  }
})

import {
  initDatabase, getDb, saveMemory, saveAgentMemory, hybridSearch, generateEmbedding, clearMemoryCache,
  backfillEmbeddings, parseEmbedKeepAlive,
} from '../db.js'
import { getSettingDefinition, validateSettingValue } from '../config-registry.js'

let queryVector: number[] = [1, 0, 0]
let bodies: Array<Record<string, unknown>> = []

beforeEach(() => {
  initDatabase(':memory:')
  clearMemoryCache()
  for (const k of Object.keys(settingValues)) delete settingValues[k]
  queryVector = [1, 0, 0]
  bodies = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return { json: async () => ({ embedding: queryVector }) }
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('embedding request', () => {
  it('with nothing set: the prompt is the text, and no keep_alive is sent (as before)', async () => {
    await generateEmbedding('hello', 'query')
    await generateEmbedding('hello', 'document')
    await generateEmbedding('hello')
    for (const b of bodies) {
      expect(b.prompt).toBe('hello')
      expect('keep_alive' in b).toBe(false)
      expect(Object.keys(b).sort()).toEqual(['model', 'prompt'])
    }
  })

  it('a query gets EMBED_QUERY_PREFIX, a stored memory EMBED_DOCUMENT_PREFIX', async () => {
    settingValues.EMBED_QUERY_PREFIX = 'search_query: '
    settingValues.EMBED_DOCUMENT_PREFIX = 'search_document: '
    saveAgentMemory('dex', 'the deploy key lives in slot seven', 'warm', undefined, true)
    await vi.waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0].prompt).toBe('search_document: the deploy key lives in slot seven')

    await hybridSearch('dex', 'where is the deploy key', 5)
    expect(bodies[1].prompt).toBe('search_query: where is the deploy key')
  })

  it('every document-side caller gets the document prefix: saveMemory and the backfill too', async () => {
    settingValues.EMBED_DOCUMENT_PREFIX = 'doc: '
    saveMemory('', 'chat memory', 'semantic', undefined, 'dex')
    await vi.waitFor(() => expect(bodies.length).toBe(1))
    expect(bodies[0].prompt).toBe('doc: chat memory')
    getDb().prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category)
       VALUES ('', 'needs a vector', 'semantic', 1.0, 1, 1, 'dex', 'warm')`,
    ).run()
    await backfillEmbeddings()
    expect(bodies.map((b) => b.prompt)).toContain('doc: needs a vector')
  })

  it('a literal \\n in a prefix is a line break (the settings field is one line), and a trailing space survives the registry', async () => {
    settingValues.EMBED_QUERY_PREFIX = 'Instruct: find it\\nQuery:'
    await generateEmbedding('hello', 'query')
    expect(bodies[0].prompt).toBe('Instruct: find it\nQuery:hello')
    const def = getSettingDefinition('EMBED_QUERY_PREFIX')!
    expect(validateSettingValue(def, 'search_query: ')).toEqual({ ok: true, value: 'search_query: ' })
  })

  it('EMBED_KEEP_ALIVE: a duration goes as a string, a bare integer as a number', async () => {
    settingValues.EMBED_KEEP_ALIVE = '30m'
    await generateEmbedding('a')
    settingValues.EMBED_KEEP_ALIVE = '-1'
    await generateEmbedding('b')
    settingValues.EMBED_KEEP_ALIVE = '  '
    await generateEmbedding('c')
    expect(bodies[0].keep_alive).toBe('30m')
    expect(bodies[1].keep_alive).toBe(-1)
    expect('keep_alive' in bodies[2]).toBe(false)
  })

  it('an unusable keep_alive is not sent (it would fail every request) and the registry refuses it', async () => {
    for (const bad of ['30 min', '+5', 'abc', '99999999999999999999']) {
      bodies = []
      settingValues.EMBED_KEEP_ALIVE = bad
      await generateEmbedding('x')
      expect('keep_alive' in bodies[0], bad).toBe(false)
      expect(parseEmbedKeepAlive(bad), bad).toBeUndefined()
      expect(getSettingDefinition('EMBED_KEEP_ALIVE')!.validate!(bad), bad).not.toBeNull()
    }
    for (const ok of ['', '0', '-1', '300', '30m', '1h30m', '1.5h']) {
      expect(getSettingDefinition('EMBED_KEEP_ALIVE')!.validate!(ok), ok).toBeNull()
    }
  })
})

describe('hybrid search fusion weights', () => {
  // B: vector rank 0 only. C: keyword rank 0 and vector rank 1. Equal weights put
  // C first (two terms); a zero keyword weight leaves B's better vector rank to
  // decide; a zero vector weight leaves only C with a score.
  function seed(): { b: number; c: number } {
    const ins = (content: string, emb: number[]) => Number(getDb().prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, embedding)
       VALUES ('', ?, 'semantic', 1.0, 1, 1, 'dex', 'warm', ?)`,
    ).run(content, JSON.stringify(emb)).lastInsertRowid)
    return { b: ins('unrelated words only', [1, 0, 0]), c: ins('zebracrossing is where it waits', [0.8, 0.6, 0]) }
  }

  it('default 1/1: the row both branches found comes first, with the unweighted score (as before)', async () => {
    const { b, c } = seed()
    const hits = await hybridSearch('dex', 'zebracrossing', 5)
    expect(hits.map((h) => h.id)).toEqual([c, b])
    expect(hits[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12)
  })

  it('MEMORY_RRF_FTS_WEIGHT = 0: the vector ranking decides', async () => {
    const { b, c } = seed()
    settingValues.MEMORY_RRF_FTS_WEIGHT = '0'
    expect((await hybridSearch('dex', 'zebracrossing', 5)).map((h) => h.id)).toEqual([b, c])
  })

  it('MEMORY_RRF_VECTOR_WEIGHT = 0: only the keyword hit carries a score', async () => {
    const { b, c } = seed()
    settingValues.MEMORY_RRF_VECTOR_WEIGHT = '0'
    const hits = await hybridSearch('dex', 'zebracrossing', 5)
    expect(hits[0].id).toBe(c)
    expect(hits.find((h) => h.id === b)?.score).toBe(0)
  })

  it('an unusable weight falls back to 1, and the registry refuses it on write', async () => {
    const { b, c } = seed()
    settingValues.MEMORY_RRF_FTS_WEIGHT = 'abc'
    settingValues.MEMORY_RRF_VECTOR_WEIGHT = '11'
    const hits = await hybridSearch('dex', 'zebracrossing', 5)
    expect(hits.map((h) => h.id)).toEqual([c, b])
    // the exact fused score with both weights at 1: keyword rank 0 + vector rank 1
    expect(hits[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12)
    expect(hits[1].score).toBeCloseTo(1 / 61, 12)
    for (const key of ['MEMORY_RRF_FTS_WEIGHT', 'MEMORY_RRF_VECTOR_WEIGHT']) {
      const def = getSettingDefinition(key)!
      expect(def.default).toBe('1')
      for (const bad of ['abc', '-1', '11']) expect(def.validate!(bad), `${key}=${bad}`).not.toBeNull()
      for (const ok of ['', '0', '0.5', '10']) expect(def.validate!(ok), `${key}=${ok}`).toBeNull()
    }
  })

  it('a weight of only whitespace counts as empty: 1, not 0', async () => {
    const { b, c } = seed()
    settingValues.MEMORY_RRF_FTS_WEIGHT = '   '
    settingValues.MEMORY_RRF_VECTOR_WEIGHT = ' '
    const hits = await hybridSearch('dex', 'zebracrossing', 5)
    expect(hits.map((h) => h.id)).toEqual([c, b])
    expect(hits[0].score).toBeCloseTo(1 / 61 + 1 / 62, 12)
  })

  it('the three embedding settings exist and default to empty (nothing changes until set)', () => {
    for (const key of ['EMBED_QUERY_PREFIX', 'EMBED_DOCUMENT_PREFIX', 'EMBED_KEEP_ALIVE']) {
      expect(getSettingDefinition(key)?.default, key).toBe('')
    }
  })
})
