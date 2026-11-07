// Card f9242cd3 (#571): the free-text "FELULIRJA <id>" chain. It is read for
// LINKS only, both directions: nothing is hidden or moved by it (review on PR
// #2031; the explicit replacement is POST /api/memories with `supersedes`).
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, getMemoryById } from '../db.js'
import { parseSupersedeRefs, getMemorySupersessions } from '../memory-supersede.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(pathAndQuery: string, method = 'GET', body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() {},
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(chunk.toString()) } catch { out.body = chunk.toString() } } },
  }
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('parseSupersedeRefs', () => {
  // The shapes measured on the owner store, 2026-10-17.
  it.each([
    ['FELULIRJA 1244-et. 2026-10-10 09:3x: ...', [{ id: 1244, partial: false }]],
    ['FELULIRJA A #219-et (2026-08-31 12:40).', [{ id: 219, partial: false }]],
    ['allapot, FELULIRJA az 1327-est: 6 kor kesz', [{ id: 1327, partial: false }]],
    ['FELÜLÍRJA 1300-at', [{ id: 1300, partial: false }]],
    ['FELULIRJA 1345: #558 modproba rejtett ugynok', [{ id: 1345, partial: false }]],
    ['FELULIRJA a 876-os emleket ket ponton', [{ id: 876, partial: true }]],
    ['FELULIRJA a 344-es hot emlek 2. pontjat', [{ id: 344, partial: true }]],
    ['FELULIRJA 1120 allapot-reszet.', [{ id: 1120, partial: true }]],
    ['FELULIRJA A 924-ES HOT EMLEK "VALOSZINU OK" SZAKASZAT.', [{ id: 924, partial: true }]],
  ])('%s', (text, want) => {
    expect(parseSupersedeRefs(5000, text)).toEqual(want)
  })

  it('a time is not an id', () => {
    expect(parseSupersedeRefs(5000, 'FELULIRJA a 20:35-os allapotot')).toEqual([])
  })

  it('a date is not an id', () => {
    expect(parseSupersedeRefs(5000, 'ez felulirja a 08-01 21:36-os allapotot')).toEqual([])
    expect(parseSupersedeRefs(5000, 'FELULIRJA a 10-17-i dontest')).toEqual([])
  })

  it('a single claim, reading or quoted piece is partial', () => {
    expect(parseSupersedeRefs(5000, 'felulirja a 3457-es memoria kuszob-ertelmezeset')).toEqual([{ id: 3457, partial: true }])
    expect(parseSupersedeRefs(5000, "FELULIRJA a 2485-os emlek 'a kapu mindent enged' allitasat")).toEqual([{ id: 2485, partial: true }])
    expect(parseSupersedeRefs(5000, 'FELULIRJA a 2485-os emlek "kapu nyitva" reszet')).toEqual([{ id: 2485, partial: true }])
    // the quote alone, with no claim/part word next to it, still makes it partial
    expect(parseSupersedeRefs(5000, "FELULIRJA a 2485-os emlek 'kapu nyitva' sorat")).toEqual([{ id: 2485, partial: true }])
  })

  it('a quote after the colon is the new text, not a piece of the old row', () => {
    expect(parseSupersedeRefs(5000, 'FELULIRJA 1244-et: "uj allapot" a 7. ponttal egyutt')).toEqual([{ id: 1244, partial: true }])
    expect(parseSupersedeRefs(5000, 'FELULIRJA 1244-et: "uj allapot", kesz')).toEqual([{ id: 1244, partial: false }])
  })

  it('two markers in one text are read separately, in both orders', () => {
    expect(parseSupersedeRefs(5000, 'FELULIRJA a 5-es emlek 2. pontjat; FELULIRJA 7-et')).toEqual([
      { id: 5, partial: true }, { id: 7, partial: false },
    ])
    expect(parseSupersedeRefs(5000, 'FELULIRJA 7-et; FELULIRJA a 5-es emlek 2. pontjat')).toEqual([
      { id: 7, partial: false }, { id: 5, partial: true },
    ])
  })

  it('the tail stops at a line break', () => {
    expect(parseSupersedeRefs(5000, 'FELULIRJA 1244-et\n2. pont: valami mas')).toEqual([{ id: 1244, partial: false }])
  })

  it('a reference to itself or a newer row is not a replacement', () => {
    expect(parseSupersedeRefs(1169, 'FELULIRJA 1169 korabbi allapotat')).toEqual([])
    expect(parseSupersedeRefs(388, 'FELULIRJA 2026-ban ...')).toEqual([])
  })

  it('the word alone, with no id, is nothing', () => {
    expect(parseSupersedeRefs(5000, 'Ez felulirja a korabbi hot emleket')).toEqual([])
  })
})

describe('the chain in the store and on the listing', () => {
  let old1: number, old2: number, partOld: number, newer: number, newest: number, partNew: number
  beforeEach(() => {
    initDatabase(':memory:')
    old1 = saveAgentMemory('agent-a', 'allapot v1', 'hot').id
    partOld = saveAgentMemory('agent-a', 'harom pontos lista', 'hot').id
    newer = saveAgentMemory('agent-a', `FELULIRJA ${old1}-et: allapot v2`, 'hot').id
    newest = saveAgentMemory('agent-a', `FELULIRJA ${old1}-et is: allapot v3`, 'hot').id
    partNew = saveAgentMemory('agent-a', `FELULIRJA a ${partOld}-es emlek 2. pontjat`, 'hot').id
    old2 = saveAgentMemory('agent-b', 'masik ugynok sora', 'warm').id
    saveAgentMemory('agent-b', `FELULIRJA ${old2}`, 'warm')
    saveAgentMemory('agent-a', 'FELULIRJA 999999-et (nincs ilyen sor)', 'hot')
  })

  it('superseded_by is the NEWEST full replacement; partial and missing rows are not replaced', () => {
    const s = getMemorySupersessions()
    expect(s.supersededBy.get(old1)).toBe(newest)
    expect(s.supersededBy.has(partOld)).toBe(false)
    expect(s.supersededBy.has(999999)).toBe(false)
    expect(s.refs.get(partNew)).toEqual([{ id: partOld, partial: true }])
  })

  it('the listing carries both directions under its own names', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&tier=hot&limit=50')
    await tryHandleMemories(ctx)
    const byId = new Map(out.body.map((m: any) => [m.id, m]))
    expect((byId.get(old1) as any).chain_replaced_by).toBe(newest)
    expect((byId.get(newer) as any).chain_refs).toEqual([{ id: old1, partial: false }])
    expect((byId.get(partOld) as any).chain_replaced_by).toBeNull()
  })

  it('nothing is hidden: a fully replaced row stays in the listing', async () => {
    for (const qs of ['agent=agent-a&tier=hot', 'tier=hot']) {
      const { ctx, out } = fakeCtx(`/api/memories?${qs}&limit=50`)
      await tryHandleMemories(ctx)
      expect(out.body.map((m: any) => m.id), qs).toContain(old1)
    }
  })

  it("the row's own supersedes column (#2124) is not overwritten by the chain", async () => {
    const { ctx: c0, out: o0 } = fakeCtx('/api/memories', 'POST', { agent_id: 'agent-a', content: 'explicit v2', category: 'hot', supersedes: [newer] })
    await tryHandleMemories(c0)
    expect(o0.status, JSON.stringify(o0.body)).toBe(200)
    const explicitId = o0.body.id
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&tier=hot&limit=50')
    await tryHandleMemories(ctx)
    const row = out.body.find((m: any) => m.id === explicitId)
    expect(row.supersedes).toBe(String(newer))
    expect(row.chain_refs).toEqual([])
  })
})

describe('write time: the free-text marker moves nothing', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('POST and PUT with a full "FELULIRJA <id>" leave the old row in its tier', async () => {
    const old = saveAgentMemory('agent-a', 'allapot v1', 'hot').id
    const { ctx, out } = fakeCtx('/api/memories', 'POST', { agent_id: 'agent-a', content: `FELULIRJA ${old}-et: allapot v2`, category: 'hot' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body.demoted).toBeUndefined()
    expect(getMemoryById(old)?.category).toBe('hot')
    const warm = saveAgentMemory('agent-a', 'allapot w1', 'warm').id
    const cur = saveAgentMemory('agent-a', 'allapot w2', 'hot').id
    const { ctx: c2, out: o2 } = fakeCtx(`/api/memories/${cur}`, 'PUT', { content: `FELULIRJA ${warm}: allapot w2` })
    await tryHandleMemories(c2)
    expect(o2.status, JSON.stringify(o2.body)).toBe(200)
    expect(o2.body.demoted).toBeUndefined()
    expect(getMemoryById(warm)?.category).toBe('warm')
  })
})
