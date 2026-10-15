// c4e47223 (1): the kanban list says how long it is and how many cards it carries.
//
// Measured before the change: GET /api/kanban went out chunked (no Content-Length),
// and a response cut by a dashboard stop reached the reader as a shorter body with
// curl exit 18 -- invalid JSON for a strict reader, but a plausible "shorter list"
// for a line counter. Now the length is promised up front (Content-Length, the
// gzipped length on the gzip branch) and the card count rides along in
// X-Total-Count, so a reader can check what it parsed against both.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { initDatabase, createKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { jsonMaybeGzip } from '../web/http-helpers.js'
import type { RouteContext } from '../web/routes/types.js'

type Out = { status: number; headers: Record<string, string>; body: Buffer }

function fakeRes(out: Out): any {
  const res: any = {
    writeHead(status: number, headers: Record<string, string> = {}) { out.status = status; out.headers = headers; return res },
    setHeader() { return res },
    end(chunk?: string | Buffer) { if (chunk != null) out.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk) },
  }
  return res
}

async function getKanban(query = '', headers: Record<string, string> = {}): Promise<Out> {
  const out: Out = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const req: any = Object.assign(Readable.from([]), { headers })
  const url = new URL(`http://localhost:3420/api/kanban${query}`)
  const ctx = { req, res: fakeRes(out), path: url.pathname, method: 'GET', url } as RouteContext
  expect(await tryHandleKanban(ctx)).toBe(true)
  return out
}

describe('GET /api/kanban: length and count up front (c4e47223)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createKanbanCard({ id: 'a1', title: 'First', assignee: 'agent-x' })
    createKanbanCard({ id: 'a2', title: 'Second', assignee: 'agent-x' })
    createKanbanCard({ id: 'b1', title: 'Third', assignee: 'agent-y' })
  })

  it('Content-Length is the body\'s byte length and X-Total-Count the array\'s length', async () => {
    const out = await getKanban()
    expect(out.status).toBe(200)
    const cards = JSON.parse(out.body.toString('utf-8'))
    expect(cards).toHaveLength(3)
    expect(out.headers['Content-Length']).toBe(String(out.body.length))
    expect(out.headers['X-Total-Count']).toBe('3')
    // Nothing else about the response changed.
    expect(out.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(out.headers['Content-Encoding']).toBeUndefined()
  })

  it('X-Total-Count counts THIS response, after the filter', async () => {
    const out = await getKanban('?agent=agent-x')
    expect(JSON.parse(out.body.toString('utf-8')).map((c: { id: string }) => c.id).sort()).toEqual(['a1', 'a2'])
    expect(out.headers['X-Total-Count']).toBe('2')
  })

  it('on the gzip branch Content-Length is the COMPRESSED length, and the count still matches', async () => {
    // Enough cards to pass the 1 KB gzip threshold.
    for (let i = 0; i < 40; i++) createKanbanCard({ id: `g${i}`, title: `Card number ${i} with some words in it`, assignee: 'agent-y' })
    const out = await getKanban('', { 'accept-encoding': 'gzip' })
    expect(out.headers['Content-Encoding']).toBe('gzip')
    expect(out.headers['Content-Length']).toBe(String(out.body.length))
    const cards = JSON.parse(gunzipSync(out.body).toString('utf-8'))
    expect(out.headers['X-Total-Count']).toBe(String(cards.length))
    expect(cards.length).toBe(43)
  })
})

describe('jsonMaybeGzip: the framing cannot be overridden by an extra header', () => {
  // Every key of the head object that names `header`, whatever its case: node
  // sends each key as its own line, so two keys are two lines on the wire.
  const named = (headers: Record<string, string>, header: string) =>
    Object.keys(headers).filter((k) => k.toLowerCase() === header)
  const call = (extra: Record<string, string>, reqHeaders: Record<string, string> = {}, data: unknown = { ok: true }) => {
    const out: Out = { status: 0, headers: {}, body: Buffer.alloc(0) }
    jsonMaybeGzip({ headers: reqHeaders } as any, fakeRes(out), data, 200, extra)
    return out
  }
  const big = { cards: Array.from({ length: 80 }, (_, i) => ({ id: `c${i}`, title: `Card ${i} with some words` })) }

  it('a caller-supplied Content-Length is replaced by the real one', () => {
    const out = call({ 'Content-Length': '999', 'X-Total-Count': '1' })
    expect(out.headers['Content-Length']).toBe(String(out.body.length))
    expect(out.headers['X-Total-Count']).toBe('1')
  })

  it('a LOWERCASE content-length is dropped too: one Content-Length, the real one', () => {
    const out = call({ 'content-length': '1', 'X-Total-Count': '1' })
    expect(named(out.headers, 'content-length')).toEqual(['Content-Length'])
    expect(out.headers['Content-Length']).toBe(String(out.body.length))
    expect(out.headers['X-Total-Count']).toBe('1')
  })

  it('an extra Content-Encoding does not mark the PLAIN branch as gzip', () => {
    const out = call({ 'Content-Encoding': 'gzip' })
    expect(named(out.headers, 'content-encoding')).toEqual([])
    expect(JSON.parse(out.body.toString('utf-8'))).toEqual({ ok: true })
  })

  it('on the gzip branch an extra content-encoding (any case) cannot replace gzip', () => {
    const out = call({ 'content-encoding': 'identity' }, { 'accept-encoding': 'gzip' }, big)
    expect(named(out.headers, 'content-encoding')).toEqual(['Content-Encoding'])
    expect(out.headers['Content-Encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(out.body).toString('utf-8')).cards).toHaveLength(80)
  })

  it('an extra Transfer-Encoding is dropped: the length stays the framing', () => {
    const out = call({ 'Transfer-Encoding': 'chunked' })
    expect(named(out.headers, 'transfer-encoding')).toEqual([])
    expect(out.headers['Content-Length']).toBe(String(out.body.length))
  })

  it('a non-framing extra replaces the default in any case, as ONE line', () => {
    const out = call({ 'cache-control': 'no-cache' })
    expect(named(out.headers, 'cache-control')).toEqual(['cache-control'])
    expect(out.headers['cache-control']).toBe('no-cache')
  })

  it('on the wire: a lowercase content-length extra leaves exactly one length line, and the body parses', async () => {
    const server = http.createServer((req, res) => jsonMaybeGzip(req, res, { ok: true }, 200, { 'content-length': '1' }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as AddressInfo
    try {
      const got = await new Promise<{ raw: string[]; body: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          let body = ''
          res.on('data', (d) => { body += String(d) })
          res.on('end', () => resolve({ raw: res.rawHeaders, body }))
        }).on('error', reject)
      })
      const lengthLines = got.raw.filter((_, i) => i % 2 === 0 && got.raw[i].toLowerCase() === 'content-length')
      expect(lengthLines).toHaveLength(1)
      expect(JSON.parse(got.body)).toEqual({ ok: true })
    } finally {
      server.close()
    }
  })
})
