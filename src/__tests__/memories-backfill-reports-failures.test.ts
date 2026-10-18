/**
 * BACKFILLZERO (card 370f34c0): POST /api/memories/backfill answered
 * {"ok":true,"count":0} both when there was nothing to embed AND when every
 * embedding call failed (Ollama not running). The two responses were
 * byte-identical, so an outage was silent. backfillEmbeddings() now reports
 * {attempted, embedded, failed} and the route turns "work pending, nothing
 * embedded" into ok:false.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { initDatabase, getDb, backfillEmbeddings } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function makeCtx(path: string, method = 'POST'): { ctx: RouteContext; getBody: () => any; status: () => number } {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    end: (body?: string) => { responseBody = body || '' },
  }
  return {
    ctx: { req: {} as any, res: res as any, path, method, url },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
    status: () => statusCode,
  }
}

// Insert directly so the embedding stays NULL (saveAgentMemory may embed).
function insertUnembedded(content: string): number {
  const now = Math.floor(Date.now() / 1000)
  const r = getDb().prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
     created_at, accessed_at, agent_id, category, auto_generated, keywords)
     VALUES ('test-chat', NULL, ?, 'semantic', 1.0, ?, ?, 'backfill-agent', 'cold', 0, NULL)`,
  ).run(content, now, now)
  return Number(r.lastInsertRowid)
}

// Embedding backend stub: any prompt containing FAIL is refused (network
// error, as when Ollama is down); everything else gets a small vector.
function stubEmbeddingBackend() {
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { prompt?: string }
    if (body.prompt?.includes('FAIL')) throw new TypeError('fetch failed')
    return { json: async () => ({ embedding: [0.1, 0.2, 0.3] }) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  // Each case starts from an empty backlog.
  getDb().prepare('DELETE FROM memories').run()
  stubEmbeddingBackend()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('backfillEmbeddings() result', () => {
  it('nothing to do: attempted 0, no backend call', async () => {
    const fetchMock = stubEmbeddingBackend()
    expect(await backfillEmbeddings()).toEqual({ attempted: 0, embedded: 0, failed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('every call fails: failed equals attempted, nothing embedded', async () => {
    const a = insertUnembedded('FAIL one')
    const b = insertUnembedded('FAIL two')
    expect(await backfillEmbeddings()).toEqual({ attempted: 2, embedded: 0, failed: 2 })
    const rows = getDb().prepare('SELECT embedding FROM memories WHERE id IN (?, ?)').all(a, b) as { embedding: string | null }[]
    expect(rows.every(r => r.embedding === null)).toBe(true)
  })

  it('partial success counts both sides', async () => {
    const ok = insertUnembedded('embeds fine')
    const bad = insertUnembedded('FAIL this one')
    expect(await backfillEmbeddings()).toEqual({ attempted: 2, embedded: 1, failed: 1 })
    const get = (id: number) => (getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }).embedding
    expect(JSON.parse(get(ok)!)).toEqual([0.1, 0.2, 0.3])
    expect(get(bad)).toBeNull()
  })
})

describe('POST /api/memories/backfill', () => {
  it('nothing to do: ok true, attempted 0', async () => {
    const { ctx, getBody, status } = makeCtx('/api/memories/backfill')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect(getBody()).toMatchObject({ ok: true, attempted: 0, embedded: 0, failed: 0 })
  })

  it('all fail: ok false, failed equals attempted, 502 -- no longer identical to "nothing to do"', async () => {
    insertUnembedded('FAIL alpha')
    insertUnembedded('FAIL beta')
    const { ctx, getBody, status } = makeCtx('/api/memories/backfill')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(status()).toBe(502)
    const body = getBody()
    expect(body).toMatchObject({ ok: false, attempted: 2, embedded: 0, failed: 2 })
    expect(body.failed).toBe(body.attempted)
  })

  it('partial success: ok true with the failure count visible', async () => {
    insertUnembedded('fine')
    insertUnembedded('FAIL gamma')
    const { ctx, getBody, status } = makeCtx('/api/memories/backfill')
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(status()).toBe(200)
    expect(getBody()).toMatchObject({ ok: true, attempted: 2, embedded: 1, failed: 1, count: 1 })
  })
})
