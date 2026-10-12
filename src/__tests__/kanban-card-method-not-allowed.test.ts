// A bare 404 cannot say WHICH half of the request was wrong. On the
// single-card path only PUT and DELETE are routed, so every other method fell
// through to the catch-all "Not found" -- byte-identical to the answer for a
// card id that does not exist. That ambiguity is not theoretical: it has twice
// sent a caller looking for the wrong bug, once concluding that an endpoint
// wrote data while answering 404, and once that a card id was rejected when in
// fact the path shape was wrong.
//
// 405 with an Allow header answers the question the 404 could not: the method
// is the problem, and here are the ones that work.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any; headers: Record<string, string> } = {
    status: 0, body: null, headers: {},
  }
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      if (headers) for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = String(v)
      return res
    },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  // readBody() consumes the request through the stream events, so a plain
  // object is not enough: it needs a real Readable.
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

const CARD = 'CARD0001'

function seedCard() {
  const now = Math.floor(Date.now() / 1000)
  getDb()
    .prepare('INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(CARD, 'Seeded card', 'planned', 'low', 0, now, now)
}

function readCard(): any {
  return getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(CARD)
}

describe('unrouted methods on the single-card path answer 405, not a bare 404', () => {
  beforeEach(() => { initDatabase(':memory:'); seedCard() })

  // PATCH is the method that caused the confusion: it looks like a partial
  // update, and a 404 reads as "no such card" rather than "no such method".
  it('PATCH answers 405 and names the methods that do work', async () => {
    const { ctx, out } = fakeCtx(`/api/kanban/${CARD}`, 'PATCH', { priority: 'normal' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(405)
    expect(out.headers.allow).toBe('PUT, DELETE')
  })

  it('POST answers 405 as well -- the rule is the method set, not one verb', async () => {
    const { ctx, out } = fakeCtx(`/api/kanban/${CARD}`, 'POST', { title: 'x' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(405)
    expect(out.headers.allow).toBe('PUT, DELETE')
  })

  // Measured, and it corrects a natural assumption: there is NO GET on this
  // path. Advertising one in the Allow header would send the next caller into
  // the same fog, one method further along.
  it('GET answers 405 too, because no single-card read route exists', async () => {
    const { ctx, out } = fakeCtx(`/api/kanban/${CARD}`, 'GET')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(405)
    expect(out.headers.allow).toBe('PUT, DELETE')
    expect(out.headers.allow).not.toContain('GET')
  })

  it('the body says the METHOD is the problem, not the card id', async () => {
    const { ctx, out } = fakeCtx(`/api/kanban/${CARD}`, 'PATCH', { priority: 'normal' })
    await tryHandleKanban(ctx)
    const text = JSON.stringify(out.body)
    expect(text).toContain('PATCH')
    expect(text).toContain('PUT')
    expect(text).toContain('DELETE')
  })
})

describe('the 405 does not swallow the real 404', () => {
  beforeEach(() => { initDatabase(':memory:'); seedCard() })

  it('PUT on a card id that does not exist still answers 404', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/NO-SUCH-CARD', 'PUT', { priority: 'normal' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.headers.allow).toBeUndefined()
  })

  it('DELETE on a card id that does not exist still answers 404', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/NO-SUCH-CARD', 'DELETE')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('PUT on a card that exists still succeeds', async () => {
    const { ctx, out } = fakeCtx(`/api/kanban/${CARD}`, 'PUT', { priority: 'high' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(readCard().priority).toBe('high')
  })
})

// The load-bearing assertion of this file. Whatever the status code says, the
// unrouted methods must never write. If one of them ever starts writing, a
// caller that trusted the error status would silently be wrong about the state
// of the board.
describe('no unrouted method may change the card', () => {
  beforeEach(() => { initDatabase(':memory:'); seedCard() })

  for (const method of ['PATCH', 'POST', 'HEAD', 'OPTIONS']) {
    it(`${method} leaves every column untouched`, async () => {
      const before = readCard()
      const { ctx } = fakeCtx(`/api/kanban/${CARD}`, method, { priority: 'urgent', status: 'done', title: 'rewritten' })
      await tryHandleKanban(ctx)
      expect(readCard()).toEqual(before)
    })
  }
})

// The 405 branch matches ANY single-segment path under /api/kanban, and some of
// those segments are fixed endpoints rather than card ids. If the branch is
// ever placed before them, they stop answering and start reporting 405 -- with
// an Allow header naming methods that would be wrong for them. Measured: with
// the branch moved above its own position, these turn red.
describe('the catch-all must not shadow the fixed single-segment endpoints', () => {
  beforeEach(() => { initDatabase(':memory:'); seedCard() })

  for (const path of ['/api/kanban/archived', '/api/kanban/labels', '/api/kanban/assignees']) {
    it(`GET ${path} is still served by its own handler`, async () => {
      const { ctx, out } = fakeCtx(path, 'GET')
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(out.status).not.toBe(405)
      expect(out.headers.allow).toBeUndefined()
    })
  }

  it('POST /api/kanban/labels is still served by its own handler', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/labels', 'POST', { name: 'teszt', color: 'blue' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).not.toBe(405)
  })
})
