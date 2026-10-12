// Config-driven embedding: EMBED_URL / EMBED_MODEL / EMBED_DIMS.
//
// Covers the two behaviours the qwen3-embedding switch introduced, both of
// which fail SILENTLY in production if they regress:
//   1. Matryoshka truncation (EMBED_DIMS). Without it a 4096-dim vector is
//      stored where 1024 is expected and every later comparison mismatches.
//   2. The dimension-mismatch skip in vectorSearch. The cosine loop walks the
//      QUERY's length, so a stored vector from a DIFFERENT model yields NaN --
//      no error, no crash, just wrong hits ranked as if they were matches.
//
// Both are proven with a negative control: the mismatched vector must NOT come
// back, and the same-length one must.
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import { initDatabase, getDb, generateEmbedding, hybridSearch, clearMemoryCache } from '../db.js'
import { EMBED_DIMS, EMBED_MODEL, EMBED_URL, OLLAMA_URL } from '../config.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => clearMemoryCache())
afterEach(() => vi.unstubAllGlobals())

function stubEmbedding(vec: number[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: vec }) })))
}

describe('generateEmbedding: model/endpoint come from config, not a literal', () => {
  it('calls the configured EMBED_URL with the configured EMBED_MODEL', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ embedding: [1, 2, 3] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await generateEmbedding('teszt')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toBe(`${EMBED_URL}/api/embeddings`)
    expect(JSON.parse(init.body).model).toBe(EMBED_MODEL)
  })

  it('truncates to EMBED_DIMS when the model returns a longer vector', async () => {
    const dims = EMBED_DIMS > 0 ? EMBED_DIMS : 1024
    stubEmbedding(Array.from({ length: dims * 2 }, (_, i) => i / 1000))
    const out = await generateEmbedding('teszt')
    // With truncation configured we get exactly EMBED_DIMS; with it off the
    // full vector must come back untouched. Both are correct -- silently
    // returning some OTHER length is not.
    expect(out?.length).toBe(EMBED_DIMS > 0 ? dims : dims * 2)
  })

  it('never pads: a vector shorter than EMBED_DIMS is returned as-is', async () => {
    stubEmbedding([0.1, 0.2, 0.3])
    expect((await generateEmbedding('teszt'))?.length).toBe(3)
  })

  it('returns null (not an empty vector) when the model answers with nothing', async () => {
    stubEmbedding([])
    expect(await generateEmbedding('teszt')).toBeNull()
  })
})

// The backward-compatibility promise this change makes is "set nothing and
// nothing changes". That promise lives entirely in two `|| OLLAMA_URL`
// fallbacks, which no other test here touches -- measured: breaking the
// EMBED_URL fallback left all five cases above GREEN. So pin it directly.
describe('defaults reproduce the previous behaviour', () => {
  it('EMBED_URL falls back to OLLAMA_URL when unset', () => {
    expect(EMBED_URL).toBe(process.env['EMBED_URL'] || OLLAMA_URL)
    expect(EMBED_URL).toMatch(/^https?:\/\/.+/)
  })

  it('EMBED_MODEL keeps the previously hardcoded literal as its default', () => {
    const def = SETTINGS_REGISTRY.find(d => d.key === 'EMBED_MODEL')
    expect(def?.default).toBe('nomic-embed-text')
  })

  it('EMBED_DIMS defaults to 0, i.e. no truncation', () => {
    const def = SETTINGS_REGISTRY.find(d => d.key === 'EMBED_DIMS')
    expect(def?.default).toBe(0)
  })
})

describe('vectorSearch: a vector of the WRONG dimension is skipped, not scored', () => {
  it('drops the mismatched row and keeps the matching one', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const insert = db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'dimtest', 'warm', ?, ?)`
    )
    // Same-length vector: comparable. Different length: from another model.
    insert.run('jo dimenzio sor', now, now, 'alpha', JSON.stringify([1, 0, 0, 0]))
    insert.run('rossz dimenzio sor', now, now, 'beta', JSON.stringify([1, 0, 0, 0, 0, 0, 0, 0]))

    stubEmbedding([1, 0, 0, 0])
    const hits = await hybridSearch('dimtest', 'zzzznincsilyenszo', 10)
    const contents = hits.map(h => h.content)
    // FTS finds nothing for the nonsense query, so anything here came from the
    // vector side -- which makes this a clean read on the skip.
    expect(contents).toContain('jo dimenzio sor')
    expect(contents).not.toContain('rossz dimenzio sor')
  })
})
