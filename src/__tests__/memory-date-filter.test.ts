/**
 * Card f90928e3, node N3: GET /api/memories accepts date= / since= / until=
 * (AC7-AC12) and applies the window IN SQL, ahead of the LIMIT, in every
 * branch. Each branch test seeds 200 NEWER rows outside the window that beat
 * the target on every ordering the branch uses: if the window were a
 * post-filter the target would be cut off by the LIMIT and the test fails
 * (the MEMKERESVAK917 failure mode).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    MAIN_AGENT_ID: 'main',
    ALLOWED_CHAT_ID: 'test-chat',
    OLLAMA_URL: '',
    APP_TZ: 'Europe/Budapest',
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb, clearMemoryCache } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { parseDateExpr, resolveDateFilter, toBudapestTs } from '../date-range.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(pathAndQuery: string) {
  const out: { status: number; body: any; headers: Record<string, string> } = { status: 200, body: null, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      if (headers) for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = String(v)
      return res
    },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = String(v) },
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(chunk.toString()) } catch { out.body = chunk.toString() } } },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

async function get(pathAndQuery: string) {
  const { ctx, out } = fakeCtx(pathAndQuery)
  await tryHandleMemories(ctx)
  return out
}

const DAY = 86_400
/** 2026-10-05 12:00 Europe/Budapest (CEST): the window every test aims at. */
const TARGET_TS = toBudapestTs('2026-10-05', false) + 12 * 3600
/** Noise lives a week later, i.e. outside date=2026-10-05 and newer than the target. */
const NOISE_TS = TARGET_TS + 7 * DAY
const NOISE_ROWS = 200

let seq = 0
function insertRow(o: {
  agent?: string; content: string; keywords?: string; category?: string
  createdAt: number; embedding?: number[]
}) {
  seq++
  getDb().prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding)
     VALUES (?, NULL, ?, 'semantic', 1.0, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    'test-chat', o.content, o.createdAt, o.createdAt, o.agent ?? 'agent-a', o.category ?? 'warm',
    o.keywords ?? null, o.embedding ? JSON.stringify(o.embedding) : null,
  )
  return seq
}

function ids(body: any[]): string[] { return body.map(r => r.content) }

beforeEach(() => {
  initDatabase(':memory:')
  clearMemoryCache()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('AC7: date= since= until= on GET /api/memories', () => {
  beforeEach(() => {
    insertRow({ content: 'regi bejegyzes', createdAt: TARGET_TS - 3 * DAY })
    insertRow({ content: 'cel bejegyzes', createdAt: TARGET_TS })
    insertRow({ content: 'kesobbi bejegyzes', createdAt: TARGET_TS + 3 * DAY })
  })

  it('date=YYYY-MM-DD selects that install-zone calendar day', async () => {
    const r = await get('/api/memories?agent=agent-a&date=2026-10-05')
    expect(r.status).toBe(200)
    expect(ids(r.body)).toEqual(['cel bejegyzes'])
  })

  it('date= takes a range and since= / until= take days', async () => {
    const range = await get('/api/memories?agent=agent-a&date=' + encodeURIComponent('2026-10-05 - 2026-10-08'))
    expect(ids(range.body).sort()).toEqual(['cel bejegyzes', 'kesobbi bejegyzes'])
    const since = await get('/api/memories?agent=agent-a&since=2026-10-06')
    expect(ids(since.body)).toEqual(['kesobbi bejegyzes'])
    const until = await get('/api/memories?agent=agent-a&until=2026-10-04')
    expect(ids(until.body)).toEqual(['regi bejegyzes'])
    const both = await get('/api/memories?agent=agent-a&since=2026-10-05&until=2026-10-05')
    expect(ids(both.body)).toEqual(['cel bejegyzes'])
  })

  it('date= takes the expressions /api/recall takes (tegnap)', async () => {
    const y = parseDateExpr('tegnap')!
    insertRow({ content: 'tegnapi bejegyzes', createdAt: toBudapestTs(y.from, false) + 12 * 3600 })
    const r = await get('/api/memories?agent=agent-a&date=tegnap')
    expect(ids(r.body)).toEqual(['tegnapi bejegyzes'])
    expect(r.headers['x-memory-search']).toContain(`date=${y.from}..${y.to}`)
  })

  it('an expression that matches no row gives an empty array, not everything', async () => {
    const r = await get('/api/memories?agent=agent-a&date=2025-01-01')
    expect(r.status).toBe(200)
    expect(r.body).toEqual([])
  })
})

describe('AC9: an invalid expression is a 400 with the accepted forms', () => {
  it.each([
    ['date=holnaputan', 'date'],
    ['date=2026-13-45', 'date'],
    ['since=valami', 'since'],
    ['until=2026-02-30', 'until'],
  ])('%s', async (qs, name) => {
    const r = await get(`/api/memories?agent=agent-a&${qs}`)
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('Recognised forms')
    expect(r.body.error.toLowerCase()).toContain(name)
  })

  it('a reversed range and date mixed with since/until are 400, never ignored', async () => {
    const reversed = await get('/api/memories?agent=agent-a&since=2026-10-09&until=2026-10-01')
    expect(reversed.status).toBe(400)
    expect(reversed.body.error).toContain('Empty range')
    const mixed = await get('/api/memories?agent=agent-a&date=2026-10-05&since=2026-10-01')
    expect(mixed.status).toBe(400)
  })

  it('no date parameter means no filter object at all', () => {
    expect(resolveDateFilter({})).toEqual({ ok: true, filter: null })
  })
})

describe('AC8: the window is applied in SQL before the LIMIT, in every branch', () => {
  it('listing (agent): 200 newer rows outside the window do not push the target out', async () => {
    insertRow({ content: 'cel sor', createdAt: TARGET_TS })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `zaj ${i}`, createdAt: NOISE_TS + i })
    const control = await get('/api/memories?agent=agent-a&limit=5')
    expect(ids(control.body)).not.toContain('cel sor')
    const r = await get('/api/memories?agent=agent-a&limit=5&date=2026-10-05')
    expect(ids(r.body)).toEqual(['cel sor'])
    expect(r.headers['x-memory-search']).toMatch(/^listing=true; hits=1; truncated=false; date=2026-10-05\.\.2026-10-05$/)
  })

  it('listing without an agent (chat scope) takes the window too', async () => {
    insertRow({ content: 'cel sor', createdAt: TARGET_TS })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `zaj ${i}`, createdAt: NOISE_TS + i })
    const r = await get('/api/memories?limit=5&date=2026-10-05')
    expect(ids(r.body)).toEqual(['cel sor'])
  })

  it('listing: offset works together with date', async () => {
    for (let i = 0; i < 6; i++) insertRow({ content: `napi ${i}`, createdAt: TARGET_TS + i })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `zaj ${i}`, createdAt: NOISE_TS + i })
    const page1 = await get('/api/memories?agent=agent-a&limit=3&date=2026-10-05')
    const page2 = await get('/api/memories?agent=agent-a&limit=3&offset=3&date=2026-10-05')
    expect(page1.status).toBe(200)
    expect(page2.status).toBe(200)
    const all = [...ids(page1.body), ...ids(page2.body)]
    expect(new Set(all).size).toBe(6)
    expect(all.every(c => c.startsWith('napi'))).toBe(true)
  })

  it('offset together with q is still a 400', async () => {
    const r = await get('/api/memories?agent=agent-a&q=valami&offset=3&date=2026-10-05')
    expect(r.status).toBe(400)
  })

  it('keyword strict: noise that out-ranks and out-dates the target', async () => {
    const pad = 'egyeb reszletek '.repeat(12)
    insertRow({ content: `${pad} billingo ${pad}`, createdAt: TARGET_TS })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `billingo billingo hiba ${i}`, keywords: 'billingo', createdAt: NOISE_TS + i })
    const control = await get('/api/memories?agent=agent-a&q=billingo&strict=1&limit=5')
    expect(control.body.every((r: any) => r.content.startsWith('billingo'))).toBe(true)
    const r = await get('/api/memories?agent=agent-a&q=billingo&strict=1&limit=5&date=2026-10-05')
    expect(r.body).toHaveLength(1)
    expect(r.body[0].content).toContain('billingo')
    expect(r.body[0].created_at).toBe(TARGET_TS)
    expect(r.headers['x-memory-search']).toBe('strict=true; relaxed=false; hits=1; date=2026-10-05..2026-10-05')
  })

  it('keyword relaxed: the OR pass is windowed too, and the label still says relaxed', async () => {
    const pad = 'egyeb reszletek '.repeat(12)
    insertRow({ content: `${pad} billingo ${pad}`, createdAt: TARGET_TS })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `billingo billingo hiba ${i}`, keywords: 'billingo', createdAt: NOISE_TS + i })
    // "xyzfoo" matches nothing, so the AND pass is empty and the OR pass runs.
    const r = await get('/api/memories?agent=agent-a&q=' + encodeURIComponent('billingo xyzfoo') + '&limit=5&date=2026-10-05')
    expect(r.body).toHaveLength(1)
    expect(r.body[0].created_at).toBe(TARGET_TS)
    expect(r.headers['x-memory-search']).toBe('strict=false; relaxed=true; hits=1; date=2026-10-05..2026-10-05')
  })

  it('keyword without an agent (chat scope) takes the window', async () => {
    const pad = 'egyeb reszletek '.repeat(12)
    insertRow({ content: `${pad} billingo ${pad}`, createdAt: TARGET_TS })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `billingo billingo hiba ${i}`, keywords: 'billingo', createdAt: NOISE_TS + i })
    const r = await get('/api/memories?q=billingo&strict=1&limit=5&date=2026-10-05')
    expect(r.body).toHaveLength(1)
    expect(r.body[0].created_at).toBe(TARGET_TS)
  })

  it('LIKE substring fallback (agent and chat scope): ordered by accessed_at, so a post-filter would lose the target', async () => {
    insertRow({ content: 'almakorteszilva cel', createdAt: TARGET_TS })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `almakorteszilva zaj ${i}`, createdAt: NOISE_TS + i })
    // "lmakorte" is a substring, not a token: FTS finds nothing, LIKE does.
    const control = await get('/api/memories?agent=agent-a&q=lmakorte&limit=5')
    expect(control.headers['x-memory-search']).toContain('hits=5')
    expect(ids(control.body)).not.toContain('almakorteszilva cel')
    for (const scope of ['agent=agent-a&', '']) {
      const r = await get(`/api/memories?${scope}q=lmakorte&limit=5&date=2026-10-05`)
      expect(ids(r.body)).toEqual(['almakorteszilva cel'])
      expect(r.body[0].match_kind).toBe('substring')
    }
  })

  it('hybrid, keyword leg: windowed before fusion', async () => {
    const pad = 'egyeb reszletek '.repeat(12)
    insertRow({ content: `${pad} billingo ${pad}`, createdAt: TARGET_TS })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `billingo billingo hiba ${i}`, keywords: 'billingo', createdAt: NOISE_TS + i })
    const r = await get('/api/memories?agent=agent-a&q=billingo&mode=hybrid&limit=5&date=2026-10-05')
    expect(r.body).toHaveLength(1)
    expect(r.body[0].created_at).toBe(TARGET_TS)
    expect(r.headers['x-memory-search']).toMatch(/fts=1; vector=0;.*; date=2026-10-05\.\.2026-10-05$/)
  })

  it('hybrid, vector leg: windowed before fusion (the target is found by its vector alone)', async () => {
    // The query embeds to [1,0,0]. The target (cos ~0.78) is clearly less
    // similar than every noise row (cos ~1), so unfiltered it never reaches
    // the top of the vector ranking; inside the window it is the only vector.
    vi.stubGlobal('fetch', async () => ({ json: async () => ({ embedding: [1, 0, 0] }) }))
    insertRow({ content: 'cel vektor sor', createdAt: TARGET_TS, embedding: [1, 0.8, 0] })
    for (let i = 0; i < NOISE_ROWS; i++) insertRow({ content: `zaj ${i}`, createdAt: NOISE_TS + i, embedding: [1, 0.01, 0] })
    const query = 'zzvektorlekerdezes'  // no lexical match anywhere
    const control = await get(`/api/memories?agent=agent-a&q=${query}&mode=hybrid&limit=5`)
    expect(ids(control.body)).not.toContain('cel vektor sor')
    const r = await get(`/api/memories?agent=agent-a&q=${query}&mode=hybrid&limit=5&date=2026-10-05`)
    expect(ids(r.body)).toEqual(['cel vektor sor'])
    expect(r.body[0].match_kind).toBe('vector')
    expect(r.headers['x-memory-search']).toMatch(/fts=0; vector=1;.*; date=2026-10-05\.\.2026-10-05$/)
  })

  it('the category filter and the window combine', async () => {
    insertRow({ content: 'warm cel', category: 'warm', createdAt: TARGET_TS })
    insertRow({ content: 'cold cel', category: 'cold', createdAt: TARGET_TS })
    const r = await get('/api/memories?agent=agent-a&category=cold&date=2026-10-05')
    expect(ids(r.body)).toEqual(['cold cel'])
  })

  it('a shared row of another agent obeys the window as well', async () => {
    insertRow({ agent: 'agent-b', category: 'shared', content: 'kozos ma', createdAt: TARGET_TS })
    insertRow({ agent: 'agent-b', category: 'shared', content: 'kozos kesobb', createdAt: NOISE_TS })
    const r = await get('/api/memories?agent=agent-a&date=2026-10-05')
    expect(ids(r.body)).toEqual(['kozos ma'])
  })
})

describe('AC10: the header reports the window that was used', () => {
  it('open sides stay empty and no date means no date field', async () => {
    insertRow({ content: 'x', createdAt: TARGET_TS })
    const since = await get('/api/memories?agent=agent-a&since=2026-10-01')
    expect(since.headers['x-memory-search']).toMatch(/; date=2026-10-01\.\.$/)
    const until = await get('/api/memories?agent=agent-a&until=2026-10-09')
    expect(until.headers['x-memory-search']).toMatch(/; date=\.\.2026-10-09$/)
    const none = await get('/api/memories?agent=agent-a')
    expect(none.headers['x-memory-search']).not.toContain('date=')
  })

  it('the filter never relaxes: a window with no match is not widened', async () => {
    insertRow({ content: 'billingo szamla', createdAt: TARGET_TS })
    const r = await get('/api/memories?agent=agent-a&q=billingo&strict=1&date=2024-01-01')
    expect(r.body).toEqual([])
    expect(r.headers['x-memory-search']).toBe('strict=true; relaxed=false; hits=0; date=2024-01-01..2024-01-01')
  })
})

describe('AC12: day boundaries around the DST change (2026-10-25) and midnight', () => {
  it('2026-10-25 is 25 hours long and its edges fall on the right side', async () => {
    const local = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    // CEST (+02:00) until 03:00, CET (+01:00) after.
    insertRow({ content: 'elozo nap 23:30', createdAt: local('2026-10-24T21:30:00Z') })   // 23:30 CEST on the 24th
    insertRow({ content: 'nap 00:30', createdAt: local('2026-10-24T22:30:00Z') })         // 00:30 CEST on the 25th
    insertRow({ content: 'nap 02:30 elso', createdAt: local('2026-10-25T00:30:00Z') })    // 02:30 CEST
    insertRow({ content: 'nap 02:30 masodik', createdAt: local('2026-10-25T01:30:00Z') }) // 02:30 CET
    insertRow({ content: 'nap 23:30', createdAt: local('2026-10-25T22:30:00Z') })         // 23:30 CET
    insertRow({ content: 'kovetkezo nap 00:30', createdAt: local('2026-10-25T23:30:00Z') }) // 00:30 CET on the 26th
    const r = await get('/api/memories?agent=agent-a&date=2026-10-25&limit=50')
    expect(ids(r.body).sort()).toEqual(['nap 00:30', 'nap 02:30 elso', 'nap 02:30 masodik', 'nap 23:30'])
  })

  it('a pinned "now" of 00:30 local resolves ma to the new local day', () => {
    const nowSec = Math.floor(Date.parse('2026-10-24T22:30:00Z') / 1000) // 00:30 CEST on the 25th
    const r = resolveDateFilter({ date: 'ma' }, nowSec)
    expect(r.ok && r.filter?.from).toBe('2026-10-25')
    expect(r.ok && r.filter?.ts.toTs).toBe(Math.floor(Date.parse('2026-10-25T22:59:59Z') / 1000))
  })
})

describe('the new index serves the listing query', () => {
  it('EXPLAIN QUERY PLAN names idx_memories_agent_created for the dated listing', () => {
    const plan = getDb().prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND created_at >= ? AND created_at <= ? ORDER BY accessed_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all('agent-a', 0, 1, 20, 0) as { detail: string }[]
    const text = plan.map(p => p.detail).join('\n')
    expect(text).toContain('idx_memories_agent_created')
    expect(text).toContain('idx_memories_category_created')  // the shared-rows side of the OR
    expect(text).not.toMatch(/SCAN memories(?! USING)/)
  })

  it('the index exists and the migration is idempotent', () => {
    const has = () => getDb().prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='idx_memories_agent_created'").get()
    expect(has()).toBeDefined()
    initDatabase(':memory:')
    expect(has()).toBeDefined()
  })
})
