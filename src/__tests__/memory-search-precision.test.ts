// Memory-search precision.
//
// Two measured failures on the live install, 2026-09-23:
//
//   1. hybrid mode: `q=zebra` returned 5 rows, every one of them from the vector
//      branch alone. The vector branch had no floor, so it always answers with
//      its top-N, however unrelated -- a nonsense query was guaranteed a result.
//   2. the relaxed (OR) keyword pass: `zebra a hogy nem` returned ~50 rows.
//      "zebra" matched nothing; the rows came from the filler words `a*`,
//      `hogy*`, `nem*`, which occur in almost every Hungarian memory.
//
// Both are reproduced below against a small in-memory fixture, not the live
// store: probing the live one would mean writing rows into the fleet's memory
// to observe a read.
//
// The fixture's vectors mimic what the calibration measured on the real
// nomic-embed-text store: every vector shares a large common component, so an
// unrelated query still scores a flat ~0.64 against everything, and a real
// match stands clearly above that plateau.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// The floor's thresholds are settings. Only the three keys this file sets are
// intercepted; every other key resolves through the real settings store.
const settingValues = vi.hoisted(() => ({} as Record<string, string>))
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key in settingValues ? settingValues[key] : actual.getEffectiveSettingValue(key),
  }
})

import {
  initDatabase, getDb, hybridSearch, searchAgentMemories, searchMemories, clearMemoryCache,
  buildRelaxedFtsExpression, vectorSimilarityFloor, vectorFloorParams,
  VECTOR_MIN_MARGIN, VECTOR_BASELINE_MIN_ROWS, VECTOR_SMALL_CORPUS_MIN_SIMILARITY,
} from '../db.js'
import { ALLOWED_CHAT_ID } from '../config.js'
import { getSettingDefinition } from '../config-registry.js'
import type { HybridSearchTrace } from '../db.js'
import { isSearchStopword } from '../memory-search-stopwords.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

const DIM = 16
const COMMON = 0.8
const UNIQUE = 0.6

function docVector(slot: number): number[] {
  const v = new Array(DIM).fill(0)
  v[0] = COMMON
  v[slot] = UNIQUE
  return v
}

// Slot 15 is used by no document: a query pointing there is related to
// nothing, and scores exactly COMMON^2 = 0.64 against every row.
const UNRELATED = docVector(15)

const ROWS: Array<{ content: string; keywords: string; slot: number }> = [
  { content: 'A PDF-olvaso eszkoz kesz, a venv a pdf mappaban van', keywords: 'pdf, eszkoz', slot: 1 },
  { content: 'A kanban kartya statusza waiting lett, mert nem jott valasz', keywords: 'kanban', slot: 2 },
  { content: 'A felmondasi ido harom honap, a szerzodes szerint', keywords: 'felmondas, szerzodes', slot: 3 },
  { content: 'A Cloudflare token lejart, hogy ujat kell kerni', keywords: 'cloudflare, token', slot: 4 },
  { content: 'Az email alairas a gazda neve, nem az asszisztense', keywords: 'email, alairas', slot: 5 },
  { content: 'A havi zaras a bankkivonatbol indul, hogy ne tevedjunk', keywords: 'havi zaras, bank', slot: 6 },
  { content: 'Az egress kapu a headless klienst is fedi, nem csak a curlt', keywords: 'egress, kliens', slot: 7 },
  { content: 'A task_runs idobelyeg milliszekundumban van, nem masodpercben', keywords: 'task_runs, idobelyeg', slot: 8 },
  { content: 'A Meta hirdetesi MCP valasztasa a biztonsagon mulik', keywords: 'meta, mcp', slot: 9 },
  { content: 'A naptar ures, az utolso esemeny augusztusban volt', keywords: 'naptar, esemeny', slot: 10 },
  { content: 'A bridge port megnyitasa a belepo laphoz kellett', keywords: 'bridge, port', slot: 11 },
  { content: 'A napi limit 5000 keres, ez mert adat, nem becsles', keywords: 'limit, kvota', slot: 12 },
]

const QUERY_VECTORS: Record<string, number[]> = {
  'zebra': UNRELATED,
  'zebra a hogy nem': UNRELATED,
  'a hogy nem': UNRELATED,
  'kanban': UNRELATED, // lexical hit whose vector is below the floor
  // No shared word with the PDF row, but semantically it is that row.
  'document text extraction tool': docVector(1),
}

function stubEmbeddings() {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const { prompt } = JSON.parse(init.body) as { prompt: string }
    return { json: async () => ({ embedding: QUERY_VECTORS[prompt] ?? UNRELATED }) }
  }))
}

function seed(rows = ROWS) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  // Direct INSERT, not saveAgentMemory: that one fires a real embedding request
  // in the background, which would race the synthetic vectors below.
  const insert = db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding)
     VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'prec', 'warm', ?, ?)`,
  )
  for (const r of rows) insert.run(r.content, now, now, r.keywords, JSON.stringify(docVector(r.slot)))
}

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

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  clearMemoryCache()
  seed()
  stubEmbeddings()
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of Object.keys(settingValues)) delete settingValues[k]
})

describe('problem 1: the vector branch has a floor', () => {
  it('a nonsense query returns no rows in hybrid mode', async () => {
    const trace: HybridSearchTrace = { ftsHits: 0, vectorHits: 0, ftsRelaxed: false, vectorOnly: false }
    const hits = await hybridSearch('prec', 'zebra', 10, trace)
    expect(hits).toEqual([])
    expect(trace.vectorHits).toBe(0)
    expect(trace.vectorOnly).toBe(false)
    // The rows were scored and dropped, not never looked at.
    expect(trace.vectorDropped).toBeGreaterThan(0)
  })

  it('a real semantic match with no shared word still comes back, and first', async () => {
    const hits = await hybridSearch('prec', 'document text extraction tool', 10)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('PDF-olvaso')
    expect(hits[0].match_kind).toBe('vector')
    expect(hits[0].similarity).toBeCloseTo(1, 5)
  })

  it('a vector hit that also matches lexically is kept, even below the floor', async () => {
    const hits = await hybridSearch('prec', 'kanban', 10)
    expect(hits).toHaveLength(1)
    expect(hits[0].content).toContain('kanban')
    // Its vector score is the flat plateau, far below the floor -- and it
    // still rides along, because the keyword branch vouches for it.
    expect(hits[0].similarity).toBeCloseTo(COMMON * COMMON, 5)
    expect(hits[0].match_kind).toBe('lexical+vector')
    expect(typeof hits[0].score).toBe('number')
  })

  it('the endpoint reports the dropped vector rows in the header', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=prec&mode=hybrid&q=zebra')
    await tryHandleMemories(ctx)
    expect(out.body).toEqual([])
    expect(out.headers['x-memory-search']).toContain('vector=0')
    expect(out.headers['x-memory-search']).toContain('vector-only=false')
    expect(out.headers['x-memory-search']).toMatch(/vector-dropped=\d+/)
  })
})

describe('the floor itself', () => {
  it('is the plateau (median similarity) plus the calibrated margin on a real-sized corpus', () => {
    const scores = Array.from({ length: VECTOR_BASELINE_MIN_ROWS }, (_, i) => 0.5 + i * 0.01)
    const median = (scores[4] + scores[5]) / 2
    expect(vectorSimilarityFloor(scores)).toBeCloseTo(median + VECTOR_MIN_MARGIN, 10)
  })

  it('falls back to the absolute floor when the corpus is too small for a median to mean anything', () => {
    expect(vectorSimilarityFloor([0.9, 0.2])).toBe(VECTOR_SMALL_CORPUS_MIN_SIMILARITY)
  })

  it('its three thresholds are settings, with the calibrated values as defaults', () => {
    expect(vectorFloorParams()).toEqual({
      minMargin: VECTOR_MIN_MARGIN,
      baselineMinRows: VECTOR_BASELINE_MIN_ROWS,
      smallCorpusMinSimilarity: VECTOR_SMALL_CORPUS_MIN_SIMILARITY,
    })
    // The registry defaults are the same numbers, so the Settings page shows what runs.
    expect(Number(getSettingDefinition('MEMORY_VECTOR_MIN_MARGIN')!.default)).toBe(VECTOR_MIN_MARGIN)
    expect(Number(getSettingDefinition('MEMORY_VECTOR_BASELINE_MIN_ROWS')!.default)).toBe(VECTOR_BASELINE_MIN_ROWS)
    expect(Number(getSettingDefinition('MEMORY_VECTOR_SMALL_CORPUS_MIN_SIMILARITY')!.default)).toBe(VECTOR_SMALL_CORPUS_MIN_SIMILARITY)

    settingValues.MEMORY_VECTOR_MIN_MARGIN = '0.25'
    settingValues.MEMORY_VECTOR_BASELINE_MIN_ROWS = '3'
    settingValues.MEMORY_VECTOR_SMALL_CORPUS_MIN_SIMILARITY = '0.9'
    expect(vectorFloorParams()).toEqual({ minMargin: 0.25, baselineMinRows: 3, smallCorpusMinSimilarity: 0.9 })
    expect(vectorSimilarityFloor([0.5, 0.6, 0.7])).toBeCloseTo(0.6 + 0.25, 10)
    expect(vectorSimilarityFloor([0.5, 0.6])).toBe(0.9)

    // Unparsable or out of range: the default, never NaN.
    settingValues.MEMORY_VECTOR_MIN_MARGIN = 'abc'
    settingValues.MEMORY_VECTOR_BASELINE_MIN_ROWS = '0'
    settingValues.MEMORY_VECTOR_SMALL_CORPUS_MIN_SIMILARITY = '1.5'
    expect(vectorFloorParams()).toEqual({
      minMargin: VECTOR_MIN_MARGIN,
      baselineMinRows: VECTOR_BASELINE_MIN_ROWS,
      smallCorpusMinSimilarity: VECTOR_SMALL_CORPUS_MIN_SIMILARITY,
    })
  })

  it('hybrid search uses the configured margin', async () => {
    // The PDF row sits at 1.0 against a 0.64 plateau: kept at the default
    // margin (floor 0.74), dropped when the margin is raised past 0.36.
    const query = 'document text extraction tool'
    expect((await hybridSearch('prec', query, 5)).some(h => h.content.includes('PDF-olvaso'))).toBe(true)
    settingValues.MEMORY_VECTOR_MIN_MARGIN = '0.4'
    const trace: HybridSearchTrace = { ftsHits: 0, vectorHits: 0, ftsRelaxed: false, vectorOnly: false }
    expect(await hybridSearch('prec', query, 5, trace)).toEqual([])
    expect(trace.vectorDropped).toBeGreaterThan(0)
  })
})

describe('problem 2: filler words alone never produce relaxed hits', () => {
  it('reproduces the shape: the filler words DO occur in the seeded rows', () => {
    // Not vacuous: were these rows free of `a`/`hogy`/`nem`, the test below
    // would pass without any stopword list.
    const rows = getDb().prepare(
      `SELECT m.id FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ?`,
    ).all('a* OR hogy* OR nem*')
    expect(rows.length).toBeGreaterThan(5)
  })

  it('a nonsense word padded with filler returns nothing on the default (relaxed-allowed) path', () => {
    const trace = { relaxed: false }
    expect(searchAgentMemories('prec', 'zebra a hogy nem', 50, trace)).toEqual([])
  })

  it('a number is content: "mennyi 5000" finds the row that holds 5000 through the relaxed pass', () => {
    // "mennyi" is a stopword, so the strict pass fails and only the number is
    // left to relax to. Searching by an amount or an ID must keep working.
    const trace = { relaxed: false }
    const hits = searchAgentMemories('prec', 'mennyi 5000', 50, trace)
    expect(trace.relaxed).toBe(true)
    expect(hits.map(h => h.content)).toEqual(['A napi limit 5000 keres, ez mert adat, nem becsles'])
  })

  it('the known cost of keeping numbers: a year rescues dated rows, labelled relaxed', () => {
    // FTS5 indexes `2026-09-23` as `2026`, `09`, `23`, so the year in an
    // otherwise unmatched query matches every row dated that year. The rows are
    // labelled relaxed, and the strict pass still returns nothing.
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    const insert = db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'prec', 'warm', ?, NULL)`,
    )
    for (let i = 1; i <= 6; i++) insert.run(`Meres 2026-09-2${i}: a heti riport elkeszult`, now, now, 'riport')
    const trace = { relaxed: false }
    expect(searchAgentMemories('prec', 'XYZZY-NINCS-ILYEN-KIFEJEZES-2026', 50, trace)).toHaveLength(6)
    expect(trace.relaxed).toBe(true)
    expect(searchAgentMemories('prec', 'XYZZY-NINCS-ILYEN-KIFEJEZES-2026', 50, undefined, false)).toEqual([])
  })

  it('a query made only of filler words gets no relaxed pass at all', () => {
    // No fixture row holds all three words, so the strict AND pass is empty,
    // and with the filler removed there is nothing left to relax to. (A row
    // that DID contain all three would still match strictly: the AND pass is
    // deliberately untouched, so strict=1 means what it meant before.)
    const trace = { relaxed: false }
    expect(searchAgentMemories('prec', 'a hogy nem', 50, trace)).toEqual([])
    expect(trace.relaxed).toBe(false)
  })

  it('the endpoint answers the same way, with the label saying zero hits', async () => {
    const { ctx, out } = fakeCtx(`/api/memories?agent=prec&q=${encodeURIComponent('zebra a hogy nem')}`)
    await tryHandleMemories(ctx)
    expect(out.body).toEqual([])
    expect(out.headers['x-memory-search']).toContain('hits=0')
  })

  it('a naturally phrased question still finds its row through the relaxed pass', () => {
    const trace = { relaxed: false }
    const hits = searchAgentMemories('prec', 'meddig tart a felmondasi ido', 50, trace)
    expect(trace.relaxed).toBe(true)
    // `ido*` also prefix-matches `idobelyeg` in another row, so the order is
    // bm25's business; what matters is that the row is found at all.
    expect(hits.some(h => h.content.includes('felmondasi ido harom'))).toBe(true)
  })

  it('a real query still returns its known row, strictly', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=prec&q=kanban')
    await tryHandleMemories(ctx)
    expect(out.body).toHaveLength(1)
    expect(out.body[0].content).toContain('kanban')
    expect(out.body[0].match_kind).toBe('strict')
    expect(out.headers['x-memory-search']).toContain('relaxed=false')
  })

  it('rows rescued by the relaxed pass say so, row by row', async () => {
    const { ctx, out } = fakeCtx(`/api/memories?agent=prec&q=${encodeURIComponent('meddig tart a felmondasi ido')}`)
    await tryHandleMemories(ctx)
    expect(out.body.length).toBeGreaterThan(0)
    expect(out.body.every((m: any) => m.match_kind === 'relaxed')).toBe(true)
  })

  it('strict=1 is unchanged: only the AND pass runs', async () => {
    const { ctx, out } = fakeCtx(`/api/memories?agent=prec&q=${encodeURIComponent('meddig tart a felmondasi ido')}&strict=1`)
    await tryHandleMemories(ctx)
    expect(out.body).toEqual([])
    expect(out.headers['x-memory-search']).toContain('strict=true')
  })
})

describe('the relaxed expression', () => {
  it('drops Hungarian and English filler words, accented or not', () => {
    expect(buildRelaxedFtsExpression('meddig tart a felmondási idő')).toBe('tart* OR felmondási* OR idő*')
    expect(buildRelaxedFtsExpression('miért nem megy a Cloudflare')).toBe('megy* OR cloudflare*')
    expect(buildRelaxedFtsExpression('what is the status of the kanban card')).toBe('status* OR kanban* OR card*')
  })

  it('drops one-character tokens, whose prefix match is every word with that letter', () => {
    expect(buildRelaxedFtsExpression('x y kanban')).toBe('kanban*')
  })

  it('keeps digit-only tokens of two or more characters: an amount or an ID is content', () => {
    expect(buildRelaxedFtsExpression('mennyi 5000')).toBe('5000*')
    expect(buildRelaxedFtsExpression('XYZZY-NINCS-ILYEN-KIFEJEZES-2026')).toBe('xyzzy* OR kifejezes* OR 2026*')
    expect(buildRelaxedFtsExpression('2026 09 23 7')).toBe('2026* OR 09* OR 23*')
  })

  it('is empty when nothing but filler is left, so no relaxed pass runs at all', () => {
    expect(buildRelaxedFtsExpression('a hogy nem')).toBe('')
    expect(buildRelaxedFtsExpression('the and of to')).toBe('')
  })

  it('knows its stopwords by their accent-free form', () => {
    expect(isSearchStopword('miért')).toBe(true)
    expect(isSearchStopword('MIERT')).toBe(true)
    expect(isSearchStopword('kanban')).toBe(false)
  })
})

// The no-agent branch (GET /api/memories?q=... without agent) searches by chat
// through searchMemories, and its X-Memory-Search label comes from the trace
// searchMemories fills in.
describe('the no-agent search says which pass ran', () => {
  beforeEach(() => {
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, category, keywords)
       VALUES (?, ?, 'semantic', 1.0, ?, ?, 'warm', ?)`,
    ).run(ALLOWED_CHAT_ID, 'A felmondasi ido harom honap, a szerzodes szerint', now, now, 'felmondas')
  })

  it('searchMemories writes trace.relaxed for both passes', () => {
    const relaxed = { relaxed: false }
    expect(searchMemories('meddig tart a felmondasi ido', ALLOWED_CHAT_ID, 50, true, undefined, relaxed).length).toBeGreaterThan(0)
    expect(relaxed.relaxed).toBe(true)
    const strict = { relaxed: true }
    expect(searchMemories('felmondasi', ALLOWED_CHAT_ID, 50, true, undefined, strict).length).toBeGreaterThan(0)
    expect(strict.relaxed).toBe(false)
  })

  it('the endpoint labels a relaxed no-agent answer relaxed=true', async () => {
    const { ctx, out } = fakeCtx(`/api/memories?q=${encodeURIComponent('meddig tart a felmondasi ido')}`)
    await tryHandleMemories(ctx)
    expect(out.body.length).toBeGreaterThan(0)
    expect(out.body.every((m: any) => m.match_kind === 'relaxed')).toBe(true)
    expect(out.headers['x-memory-search']).toContain('relaxed=true')
  })
})
