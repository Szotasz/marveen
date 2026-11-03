// Retraction and replacement of memories.
//
// POST /api/memories/:id/retract takes back one's own memory without deleting
// it: the row stays readable by id, but no recall, search or listing returns it.
// POST /api/memories with `supersedes` saves a new memory that retracts the
// author's own older ones and records which.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import {
  initDatabase, getDb, saveAgentMemory, getAgentMemories, searchAgentMemories, searchMemories,
  recentMemories, getMemoriesForChat, recallByDateRange, recallSearch, hybridSearch, queryAuditLog,
  backfillEmbeddings,
} from '../db.js'
import { exportFleet } from '../web/fleet-transfer.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(method: string, path: string, body?: unknown, xAgentId?: string): Promise<{ status: number; body: any }> {
  const url = new URL(`http://localhost:3420${path}`)
  let status = 200
  let sent = ''
  const res = {
    writeHead: (code: number) => { status = code },
    setHeader: () => {},
    end: (b?: string) => { sent = b || '' },
  }
  const req = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  const ctx = {
    req, res, path: url.pathname, method, url,
    auth: xAgentId ? { kind: 'token', agent: xAgentId } : { kind: 'token' },
  } as unknown as RouteContext
  expect(await tryHandleMemories(ctx)).toBe(true)
  return { status, body: sent ? JSON.parse(sent) : null }
}

const row = (id: number) => getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>
const save = (agent: string, content: string, category = 'warm') => saveAgentMemory(agent, content, category, 'kw', true).id

let queryVector: number[] = [1, 0, 0]

beforeEach(() => {
  initDatabase(':memory:')
  queryVector = [1, 0, 0]
  // Embedding endpoint stub: every text gets the current query vector, so the
  // vector branch scores every row alike.
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: queryVector }) })))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('POST /api/memories/:id/retract', () => {
  it('the author retracts; the row stays readable by id with retracted_at; a second call says already_retracted', async () => {
    const id = save('dex', 'the deploy key lives in vault slot seven')
    const r = await call('POST', `/api/memories/${id}/retract`, { agent_id: 'dex' })
    expect(r).toEqual({ status: 200, body: { ok: true, id, outcome: 'retracted' } })
    const byId = await call('GET', `/api/memories/${id}`)
    expect(byId.status).toBe(200)
    expect(byId.body.retracted_at).toEqual(expect.any(Number))
    expect(byId.body.content).toBe('the deploy key lives in vault slot seven')
    expect((await call('POST', `/api/memories/${id}/retract`, { agent_id: 'dex' })).body.outcome).toBe('already_retracted')
  })

  it('another agent cannot retract it (403), and the row is untouched', async () => {
    const id = save('dex', 'mine')
    expect((await call('POST', `/api/memories/${id}/retract`, { agent_id: 'ana' })).status).toBe(403)
    expect(row(id).retracted_at).toBeNull()
  })

  it('X-Agent-Id names the author when the body does not; the two disagreeing is a 400', async () => {
    const id = save('dex', 'mine')
    expect((await call('POST', `/api/memories/${id}/retract`, { agent_id: 'dex' }, 'ana')).status).toBe(400)
    expect(row(id).retracted_at).toBeNull()
    expect((await call('POST', `/api/memories/${id}/retract`, undefined, 'dex')).body.outcome).toBe('retracted')
  })

  it('no such memory is a 404; a malformed agent_id or a body that is not an object is a 400', async () => {
    expect((await call('POST', '/api/memories/999/retract', { agent_id: 'dex' })).status).toBe(404)
    const id = save(MAIN_AGENT_ID, 'the main agent\'s')
    for (const bad of [{ agent_id: 7 }, 7, 'dex', [], null]) {
      expect((await call('POST', `/api/memories/${id}/retract`, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(row(id).retracted_at).toBeNull()
  })

  it('with no body and no X-Agent-Id the author is the main agent (the same default as a save)', async () => {
    const mains = save(MAIN_AGENT_ID, 'main')
    const theirs = save('dex', 'dex')
    expect((await call('POST', `/api/memories/${theirs}/retract`)).status).toBe(403)
    expect((await call('POST', `/api/memories/${mains}/retract`)).body.outcome).toBe('retracted')
  })

  it('another agent on an already retracted row still gets 403, not already_retracted', async () => {
    const id = save('dex', 'mine')
    await call('POST', `/api/memories/${id}/retract`, { agent_id: 'dex' })
    expect((await call('POST', `/api/memories/${id}/retract`, { agent_id: 'ana' })).status).toBe(403)
  })
})

describe('a retracted memory leaves every recall path', () => {
  // Each reader is asked for a phrase only the target row carries. The positive
  // control (found before the retraction) is what makes the absence afterwards
  // mean something.
  const readers: Array<[string, (agent: string) => Promise<number[]> | number[]]> = [
    ['getAgentMemories (listing)', (a) => getAgentMemories(a, 50).map((m) => m.id)],
    ['getAgentMemories (listing, by category)', (a) => getAgentMemories(a, 50, 'warm').map((m) => m.id)],
    ['searchAgentMemories (FTS)', (a) => searchAgentMemories(a, 'zebracrossing', 50).map((m) => m.id)],
    ['searchAgentMemories (FTS, by category)', (a) => searchAgentMemories(a, 'zebracrossing', 50, undefined, true, 'warm').map((m) => m.id)],
    ['searchMemories (chat FTS)', () => searchMemories('zebracrossing', '', 50).map((m) => m.id)],
    ['searchMemories (chat FTS, by category)', () => searchMemories('zebracrossing', '', 50, true, 'warm').map((m) => m.id)],
    ['recentMemories', () => recentMemories('', 50).map((m) => m.id)],
    ['getMemoriesForChat', () => getMemoriesForChat('', 50).map((m) => m.id)],
    ['getMemoriesForChat (by category)', () => getMemoriesForChat('', 50, 0, 'warm').map((m) => m.id)],
    ['recallByDateRange', (a) => recallByDateRange('2000-01-01', '2100-01-01', a).memories.map((m) => m.id)],
    ['recallByDateRange (all agents)', () => recallByDateRange('2000-01-01', '2100-01-01').memories.map((m) => m.id)],
    ['recallSearch', (a) => recallSearch('zebracrossing', a).memories.map((m) => m.id)],
    ['recallSearch (all agents)', () => recallSearch('zebracrossing').memories.map((m) => m.id)],
    ['hybridSearch (vector branch)', async (a) => (await hybridSearch(a, 'qqqnomatch', 50)).map((m) => m.id)],
    ['hybridSearch (vector branch, by category)', async (a) => (await hybridSearch(a, 'qqqnomatch', 50, undefined, 'warm')).map((m) => m.id)],
    ['GET /api/memories?agent&q&category (substring fallback)', async (a) => (await call('GET', `/api/memories?agent=${a}&q=ebracrossin&category=warm`)).body.map((m: { id: number }) => m.id)],
    ['GET /api/memories?q&category (substring fallback, no agent)', async () => (await call('GET', '/api/memories?q=ebracrossin&category=warm')).body.map((m: { id: number }) => m.id)],
    ['GET /api/memories?agent&q (substring fallback)', async (a) => (await call('GET', `/api/memories?agent=${a}&q=ebracrossin`)).body.map((m: { id: number }) => m.id)],
    ['GET /api/memories?q (substring fallback, no agent)', async () => (await call('GET', '/api/memories?q=ebracrossin')).body.map((m: { id: number }) => m.id)],
  ]

  for (const [name, read] of readers) {
    it(name, async () => {
      const id = save('dex', 'zebracrossing is where the cat waits')
      getDb().prepare("UPDATE memories SET embedding = ? WHERE id = ?").run(JSON.stringify([1, 0, 0]), id)
      expect(await read('dex')).toContain(id)
      expect((await call('POST', `/api/memories/${id}/retract`, { agent_id: 'dex' })).body.outcome).toBe('retracted')
      expect(await read('dex')).not.toContain(id)
    })
  }

  // The LIKE fallbacks behind an FTS query that throws: the FTS table is renamed
  // away for the READS only (every MATCH then fails), and back for the retraction,
  // whose FTS-sync trigger needs it.
  const ftsOff = () => getDb().exec('ALTER TABLE memories_fts RENAME TO memories_fts_off')
  const ftsOn = () => getDb().exec('ALTER TABLE memories_fts_off RENAME TO memories_fts')
  const ftsBrokenReaders: Array<[string, (agent: string) => number[]]> = [
    ['searchAgentMemories (FTS failing: LIKE)', (a) => searchAgentMemories(a, 'zebracrossing', 50).map((m) => m.id)],
    ['searchAgentMemories (FTS failing: LIKE, by category)', (a) => searchAgentMemories(a, 'zebracrossing', 50, undefined, true, 'warm').map((m) => m.id)],
    ['recallSearch (FTS failing: LIKE)', (a) => recallSearch('zebracrossing', a).memories.map((m) => m.id)],
    ['recallSearch (FTS failing: LIKE, all agents)', () => recallSearch('zebracrossing').memories.map((m) => m.id)],
  ]
  for (const [name, read] of ftsBrokenReaders) {
    it(name, async () => {
      const id = save('dex', 'zebracrossing is where the cat waits')
      ftsOff()
      expect(read('dex')).toContain(id)
      ftsOn()
      expect((await call('POST', `/api/memories/${id}/retract`, { agent_id: 'dex' })).body.outcome).toBe('retracted')
      ftsOff()
      expect(read('dex')).not.toContain(id)
      ftsOn()
    })
  }

  it('embedding backfill skips it (it is never searched again)', async () => {
    // Inserted directly: a save would start its own embedding request.
    const insert = (content: string) => Number(getDb().prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category)
       VALUES ('', ?, 'semantic', 1.0, 1, 1, 'dex', 'warm')`,
    ).run(content).lastInsertRowid)
    const live = insert('live, needs an embedding')
    const gone = insert('retracted, needs none')
    getDb().prepare('UPDATE memories SET retracted_at = 1 WHERE id = ?').run(gone)
    await backfillEmbeddings()
    expect(row(live).embedding).not.toBeNull()
    expect(row(gone).embedding).toBeNull()
  })

  it('embedding backfill does not re-embed it when its vector is from another model', async () => {
    const insert = (content: string) => Number(getDb().prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, embedding, embedding_model)
       VALUES ('', ?, 'semantic', 1.0, 1, 1, 'dex', 'warm', '[0,1,0]', 'some-older-model')`,
    ).run(content).lastInsertRowid)
    const live = insert('live, stale vector')
    const gone = insert('retracted, stale vector')
    getDb().prepare('UPDATE memories SET retracted_at = 1 WHERE id = ?').run(gone)
    await backfillEmbeddings()
    expect(row(live).embedding_model).not.toBe('some-older-model')
    expect(row(gone).embedding_model).toBe('some-older-model')
  })

  it('a shared memory leaves every agent\'s listing at once (the cache is dropped)', async () => {
    const id = save('dex', 'shared zebracrossing note', 'shared')
    expect(getAgentMemories('ana', 50).map((m) => m.id)).toContain(id) // cached for ana now
    await call('POST', `/api/memories/${id}/retract`, { agent_id: 'dex' })
    expect(getAgentMemories('ana', 50).map((m) => m.id)).not.toContain(id)
  })

  it('the fleet export leaves it behind; the audit log still shows it', () => {
    const id = save('dex', 'zebracrossing export check')
    const exported = () => (JSON.parse(exportFleet().data) as { memories: Array<{ content: string }> }).memories
    expect(exported().some((m) => m.content === 'zebracrossing export check')).toBe(true)
    getDb().prepare('UPDATE memories SET retracted_at = 1 WHERE id = ?').run(id)
    expect(exported().some((m) => m.content === 'zebracrossing export check')).toBe(false)
    expect(queryAuditLog({ sources: ['diary'], limit: 50 }).some((e) => e.id === id && e.source === 'diary')).toBe(true)
  })
})

describe('POST /api/memories with supersedes', () => {
  it('saves the new memory, retracts the author\'s listed ones, and records them', async () => {
    const a = save('dex', 'old A')
    const b = save('dex', 'old B')
    const r = await call('POST', '/api/memories', { agent_id: 'dex', content: 'new, replaces A and B', category: 'warm', supersedes: [a, b] })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, superseded: [a, b], skipped: [] })
    expect(row(a).retracted_at).toEqual(expect.any(Number))
    expect(row(b).retracted_at).toEqual(expect.any(Number))
    expect(row(r.body.id).supersedes).toBe(`${a},${b}`)
    expect(row(r.body.id).retracted_at).toBeNull()
  })

  it('another agent\'s memory, a missing one and an already retracted one are skipped and named; the save still happens', async () => {
    const theirs = save('ana', 'not dex\'s')
    const gone = save('dex', 'already withdrawn')
    getDb().prepare('UPDATE memories SET retracted_at = 1 WHERE id = ?').run(gone)
    const r = await call('POST', '/api/memories', { agent_id: 'dex', content: 'new', supersedes: [theirs, 9999, gone] })
    expect(r.status).toBe(200)
    expect(r.body.superseded).toEqual([])
    expect(r.body.skipped).toEqual([
      { id: theirs, reason: 'not_owner' },
      { id: 9999, reason: 'not_found' },
      { id: gone, reason: 'already_retracted' },
    ])
    expect(row(theirs).retracted_at).toBeNull()
    expect(row(r.body.id).supersedes).toBeNull()
  })

  it('a malformed supersedes is a 400 and nothing is saved', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n
    for (const bad of [5, '5', [0], [-1], [1.5], ['1'], [null], Array.from({ length: 51 }, (_, i) => i + 1)]) {
      expect((await call('POST', '/api/memories', { agent_id: 'dex', content: 'x', supersedes: bad })).status, JSON.stringify(bad)).toBe(400)
    }
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(before)
  })

  it('fifty ids are still accepted (the limit is inclusive)', async () => {
    const r = await call('POST', '/api/memories', { agent_id: 'dex', content: 'new', supersedes: Array.from({ length: 50 }, (_, i) => 1000 + i) })
    expect(r.status).toBe(200)
    expect(r.body.skipped).toHaveLength(50)
  })

  it('an empty list is still a replacing save: the answer says it replaced nothing', async () => {
    const r = await call('POST', '/api/memories', { agent_id: 'dex', content: 'new', supersedes: [] })
    expect(r.body).toEqual({ ok: true, id: r.body.id, superseded: [], skipped: [] })
  })

  it('a repeated id is named once as a duplicate; the new row\'s own id is named as self', async () => {
    const a = save('dex', 'old A')
    const next = a + 1 // AUTOINCREMENT: the id the new row will get
    const r = await call('POST', '/api/memories', { agent_id: 'dex', content: 'new', supersedes: [a, a, next] })
    expect(r.body.id).toBe(next)
    expect(r.body.superseded).toEqual([a])
    expect(r.body.skipped).toEqual([{ id: a, reason: 'duplicate' }, { id: next, reason: 'self' }])
    expect(row(next).retracted_at).toBeNull()
  })

  it('the replacing save takes its author from X-Agent-Id too, so it cannot retract the main agent\'s rows by default', async () => {
    const mains = save(MAIN_AGENT_ID, 'the main agent\'s shared note', 'shared')
    const mine = save('dex', 'dex\'s own')
    const r = await call('POST', '/api/memories', { content: 'new', supersedes: [mains, mine] }, 'dex')
    expect(r.body.superseded).toEqual([mine])
    expect(r.body.skipped).toEqual([{ id: mains, reason: 'not_owner' }])
    expect(row(mains).retracted_at).toBeNull()
    expect(row(r.body.id).agent_id).toBe('dex')
    // and a body agent_id that contradicts the header is refused, nothing saved
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n
    expect((await call('POST', '/api/memories', { agent_id: MAIN_AGENT_ID, content: 'x', supersedes: [mains] }, 'dex')).status).toBe(400)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(before)
    expect(row(mains).retracted_at).toBeNull()
  })

  it('supersedes: null is a plain save, as before the field existed', async () => {
    const a = save('dex', 'old A')
    const r = await call('POST', '/api/memories', { agent_id: 'dex', content: 'new', supersedes: null })
    expect(r.body).toEqual({ ok: true, id: r.body.id })
    expect(row(a).retracted_at).toBeNull()
  })

  it('control: without supersedes the answer and the row are as before', async () => {
    const r = await call('POST', '/api/memories', { agent_id: 'dex', content: 'plain' })
    expect(r.body).toEqual({ ok: true, id: r.body.id })
    expect(row(r.body.id).supersedes).toBeNull()
  })
})
