// Card f9242cd3 (#571): the "FELULIRJA <id>" chain. A full replacement links
// both ways and the replaced row can be left out of the listing; a PARTIAL
// reference only links (hiding the older row would lose what still stands).
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, getMemoryById, getMemoryVersions } from '../db.js'
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

  it('the listing carries both directions', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&tier=hot&limit=50')
    await tryHandleMemories(ctx)
    const byId = new Map(out.body.map((m: any) => [m.id, m]))
    expect((byId.get(old1) as any).superseded_by).toBe(newest)
    expect((byId.get(newer) as any).supersedes).toEqual([{ id: old1, partial: false }])
    expect((byId.get(partOld) as any).superseded_by).toBeNull()
  })

  it('superseded=hide leaves out fully replaced rows, with and without an agent filter', async () => {
    for (const qs of ['agent=agent-a&tier=hot', 'tier=hot', 'tier=warm']) {
      const { ctx, out } = fakeCtx(`/api/memories?${qs}&superseded=hide&limit=50`)
      await tryHandleMemories(ctx)
      const ids = out.body.map((m: any) => m.id)
      expect(ids, qs).not.toContain(old1)
      expect(ids, qs).not.toContain(old2)
    }
    const { ctx, out } = fakeCtx('/api/memories?tier=hot&superseded=hide&limit=50')
    await tryHandleMemories(ctx)
    const ids = out.body.map((m: any) => m.id)
    // Partial reference: the older row stays.
    expect(ids).toContain(partOld)
    expect(ids).toContain(newer)
  })

  it('without the parameter nothing is hidden', async () => {
    const { ctx, out } = fakeCtx('/api/memories?tier=hot&limit=50')
    await tryHandleMemories(ctx)
    expect(out.body.map((m: any) => m.id)).toContain(old1)
  })

  it('a bad value and the search combination answer 400', async () => {
    for (const qs of ['superseded=yes', 'superseded=hide&q=allapot']) {
      const { ctx, out } = fakeCtx(`/api/memories?${qs}`)
      await tryHandleMemories(ctx)
      expect(out.status, qs).toBe(400)
    }
  })

  it('stats count the replaced rows per tier', async () => {
    const { ctx, out } = fakeCtx('/api/memories/stats')
    await tryHandleMemories(ctx)
    expect(out.body.supersededByTier).toEqual({ hot: 1, warm: 1 })
  })
})

describe('write time: a full replacement moves the old hot/warm row to cold', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('POST with "FELULIRJA <id>" demotes the replaced hot row, keeps a version, says so', async () => {
    const old = saveAgentMemory('agent-a', 'allapot v1', 'hot').id
    const { ctx, out } = fakeCtx('/api/memories', 'POST', { agent_id: 'agent-a', content: `FELULIRJA ${old}-et: allapot v2`, category: 'hot' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(out.body.demoted).toEqual([old])
    expect(getMemoryById(old)?.category).toBe('cold')
    expect(getMemoryVersions(old).length).toBeGreaterThan(0)
  })

  it('a partial reference, a shared row, a cold row and a missing row are left alone', async () => {
    const part = saveAgentMemory('agent-a', 'harom pont', 'warm').id
    const shared = saveAgentMemory('agent-a', 'kozos', 'shared').id
    const cold = saveAgentMemory('agent-a', 'regi', 'cold').id
    const content = `FELULIRJA a ${part}-es emlek 2. pontjat. FELULIRJA ${shared}-t. FELULIRJA ${cold}-t. FELULIRJA 999999-et.`
    const { ctx, out } = fakeCtx('/api/memories', 'POST', { agent_id: 'agent-a', content, category: 'warm' })
    await tryHandleMemories(ctx)
    expect(out.body.demoted).toBeUndefined()
    expect(getMemoryById(part)?.category).toBe('warm')
    expect(getMemoryById(shared)?.category).toBe('shared')
    expect(getMemoryById(cold)?.category).toBe('cold')
  })

  it('a PUT that adds the marker demotes too; a PUT that does not change content does not', async () => {
    const old = saveAgentMemory('agent-a', 'allapot v1', 'warm').id
    const cur = saveAgentMemory('agent-a', 'allapot v2', 'hot').id
    const { ctx: c1, out: o1 } = fakeCtx(`/api/memories/${cur}`, 'PUT', { tier: 'hot' })
    await tryHandleMemories(c1)
    expect(o1.body.demoted).toBeUndefined()
    expect(getMemoryById(old)?.category).toBe('warm')
    const { ctx: c2, out: o2 } = fakeCtx(`/api/memories/${cur}`, 'PUT', { content: `FELULIRJA ${old}: allapot v2` })
    await tryHandleMemories(c2)
    expect(o2.status, JSON.stringify(o2.body)).toBe(200)
    expect(o2.body.demoted).toEqual([old])
    expect(getMemoryById(old)?.category).toBe('cold')
  })
})
