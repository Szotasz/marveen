// Card a9dfb378 (#573): a real "was it used" signal next to accessed_at.
// accessed_at is stamped by every search hit, relaxed near-misses included;
// memory_uses logs only an agent's read by id, a top hit of a search that
// matched as asked, and a partial FELULIRJA reference.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, saveAgentMemory, getDb, recordMemoryUse, getMemoryUseSummaries, deleteMemoryById } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

type Auth = RouteContext['auth']

function fakeCtx(pathAndQuery: string, auth: Auth, method = 'GET', body?: unknown) {
  const out: { status: number; body: any; headers: Record<string, string> } = { status: 200, body: null, headers: {} }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader(k: string, v: string) { out.headers[k.toLowerCase()] = v },
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(chunk.toString()) } catch { out.body = chunk.toString() } } },
  }
  const req: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  return { ctx: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
}

const agent = (name?: string): Auth => ({ kind: 'token', agent: name })
const owner: Auth = { kind: 'session', user: 'owner' } as Auth

function uses(id: number) {
  return getDb().prepare('SELECT kind, agent_id FROM memory_uses WHERE memory_id = ? ORDER BY id').all(id)
}

describe('recordMemoryUse', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('logs once per agent+kind within the window, and skips missing rows', () => {
    const id = saveAgentMemory('agent-a', 'egy sor', 'warm').id
    expect(recordMemoryUse([id, id], 'read', 'agent-a')).toBe(1)
    expect(recordMemoryUse([id], 'read', 'agent-a')).toBe(0)
    expect(recordMemoryUse([id], 'read', 'agent-b')).toBe(1)
    expect(recordMemoryUse([id], 'search', 'agent-a')).toBe(1)
    expect(recordMemoryUse([999999], 'read', 'agent-a')).toBe(0)
    expect(getMemoryUseSummaries([id]).get(id)?.use_count).toBe(3)
  })

  it('a deleted row takes its uses with it', () => {
    const id = saveAgentMemory('agent-a', 'egy sor', 'warm').id
    recordMemoryUse([id], 'read', 'agent-a')
    deleteMemoryById(id)
    expect(uses(id)).toEqual([])
  })
})

describe('what counts as a use on the API', () => {
  let a: number
  beforeEach(() => {
    initDatabase(':memory:')
    a = saveAgentMemory('agent-a', 'kalibracio a nyomtatohoz', 'warm').id
  })

  it('an agent reading a row by id is a use; the owner looking at it is not', async () => {
    await tryHandleMemories(fakeCtx(`/api/memories/${a}`, owner).ctx)
    expect(uses(a)).toEqual([])
    const { ctx, out } = fakeCtx(`/api/memories/${a}`, agent('agent-b'))
    await tryHandleMemories(ctx)
    expect(uses(a)).toEqual([{ kind: 'read', agent_id: 'agent-b' }])
    expect(out.body.use_count).toBe(1)
    expect(typeof out.body.last_used_at).toBe('number')
  })

  it('a search that matched as asked logs its top rows', async () => {
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=kalibracio&mode=fts', agent('agent-a'))
    await tryHandleMemories(ctx)
    expect(out.body.map((m: any) => m.id)).toContain(a)
    expect(uses(a)).toEqual([{ kind: 'search', agent_id: 'agent-a' }])
  })

  it('a relaxed (rescued) search is not a use, though it still stamps accessed_at', async () => {
    getDb().prepare('UPDATE memories SET accessed_at = 1 WHERE id = ?').run(a)
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=nincsilyenszo+nyomtatohoz&mode=fts', agent('agent-a'))
    await tryHandleMemories(ctx)
    expect(out.headers['x-memory-search']).toContain('relaxed=true')
    expect(out.body.map((m: any) => m.id)).toContain(a)
    expect(uses(a)).toEqual([])
    const row = getDb().prepare('SELECT accessed_at FROM memories WHERE id = ?').get(a) as { accessed_at: number }
    expect(row.accessed_at).toBeGreaterThan(1)
  })

  it('only the top three of a search count', async () => {
    const ids = [1, 2, 3, 4, 5].map(i => saveAgentMemory('agent-a', `kozos szo ${i}`, 'warm').id)
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&q=kozos&mode=fts', agent('agent-a'))
    await tryHandleMemories(ctx)
    expect(out.body.length).toBe(5)
    const logged = ids.filter(id => uses(id).length > 0)
    expect(logged.length).toBe(3)
  })

  it('a partial FELULIRJA reference is a use of the older row; a full one is not', async () => {
    const full = saveAgentMemory('agent-a', 'regi allapot', 'hot').id
    await tryHandleMemories(fakeCtx('/api/memories', agent('agent-a'), 'POST',
      { agent_id: 'agent-a', category: 'hot', content: `FELULIRJA a ${a}-es emlek 2. pontjat; FELULIRJA ${full}-et` }).ctx)
    expect(uses(a)).toEqual([{ kind: 'reference', agent_id: 'agent-a' }])
    expect(uses(full)).toEqual([])
  })

  it('the listing carries last_used_at / use_count and the tracking start', async () => {
    recordMemoryUse([a], 'read', 'agent-b')
    const b = saveAgentMemory('agent-a', 'soha nem hasznalt', 'warm').id
    const { ctx, out } = fakeCtx('/api/memories?agent=agent-a&tier=warm&limit=50', owner)
    await tryHandleMemories(ctx)
    const byId = new Map(out.body.map((m: any) => [m.id, m]))
    expect((byId.get(a) as any).use_count).toBe(1)
    expect((byId.get(b) as any).last_used_at).toBeNull()
    expect(Number(out.headers['x-memory-use-since'])).toBeGreaterThan(0)
    // listing by the owner is not a use
    expect(uses(b)).toEqual([])
  })
})
