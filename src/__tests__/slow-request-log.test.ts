// Card 12b0f698: one dashboard.log line for every request slower than 2 s -- method, path, query
// keys, status, size, time -- and no secret: a card id, an agent name with a digit or the invite
// token a DELETE path carries never reaches the line, nor any query value (an SSE ?token=).
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describeRequestPath, trackSlowRequest, SLOW_REQUEST_MS } from '../web/slow-request-log.js'

const url = (s: string) => new URL(`http://localhost:3420${s}`)

describe('describeRequestPath: route words only, query keys only', () => {
  it('keeps the route words and replaces ids, tokens and digits with :x', () => {
    expect(describeRequestPath(url('/api/kanban')).path).toBe('/api/kanban')
    expect(describeRequestPath(url('/api/kanban/heartbeat-summary')).path).toBe('/api/kanban/heartbeat-summary')
    expect(describeRequestPath(url('/api/kanban/12b0f698/comments')).path).toBe('/api/kanban/:x/comments')
    const invite = 'Xk3_9fQzLmP0aB-cD7eF1g'
    expect(describeRequestPath(url(`/api/agents/agent-9/channels/telegram/invites/${invite}`)).path)
      .toBe('/api/agents/:x/channels/telegram/invites/:x')
    expect(describeRequestPath(url('/api/agents/x/channels/telegram/allowed/user/1000000001')).path)
      .toBe('/api/agents/x/channels/telegram/allowed/user/:x')
  })

  it('the query is its keys, each once, never a value', () => {
    const d = describeRequestPath(url('/api/kanban?agent=agent-x&token=TITKOS-ERTEK&agent=masik&status=done'))
    expect(d.query).toEqual(['agent', 'token', 'status'])
    expect(JSON.stringify(d)).not.toContain('TITKOS')
    expect(JSON.stringify(d)).not.toContain('agent-x')
  })
})

// A response object with the parts trackSlowRequest touches, and a clock the test moves.
function fakeRes() {
  const res: any = new EventEmitter()
  res.statusCode = 200
  res.writableFinished = false
  res.headers = {} as Record<string, string>
  res.writeHead = (status: number, headers?: Record<string, string>) => { res.statusCode = status; if (headers) Object.assign(res.headers, headers); return res }
  res.getHeader = (name: string) => res.headers[name]
  res.write = () => true
  res.end = () => { res.writableFinished = true; res.emit('finish'); res.emit('close'); return res }
  return res
}

describe('trackSlowRequest: one line when the request took 2 s or more', () => {
  it('a fast request leaves nothing; the threshold is 2000 ms', () => {
    expect(SLOW_REQUEST_MS).toBe(2000)
    let t = 0
    const lines: unknown[] = []
    const res = fakeRes()
    trackSlowRequest(res, 'GET', url('/api/kanban'), { now: () => t, log: (f) => lines.push(f) })
    t = 1999
    res.end('[]')
    expect(lines).toEqual([])
  })

  it('a slow request leaves exactly one line with method, path, query keys, status, size and time', () => {
    let t = 1000
    const lines: any[] = []
    const res = fakeRes()
    trackSlowRequest(res, 'GET', url('/api/kanban/aaaa0001?fields=title&token=TITOK'), { now: () => t, log: (f, msg) => lines.push({ ...f, msg }) })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"id":')
    t = 3500
    res.end(Buffer.from('"a"}'))
    expect(lines).toEqual([{ method: 'GET', path: '/api/kanban/:x', query: ['fields', 'token'], status: 200, bytes: 10, ms: 2500, complete: true, msg: 'slow request' }])
  })

  it('a client that leaves early is logged once, as incomplete', () => {
    let t = 0
    const lines: any[] = []
    const res = fakeRes()
    trackSlowRequest(res, 'GET', url('/api/kanban'), { now: () => t, log: (f) => lines.push(f) })
    t = 5000
    res.emit('close')
    res.emit('close')
    expect(lines).toHaveLength(1)
    expect(lines[0].complete).toBe(false)
  })

  it('an event stream is long by design, not slow: no line, also when its type came through writeHead', () => {
    let t = 0
    const lines: unknown[] = []
    const res = fakeRes()
    res.getHeader = () => undefined
    trackSlowRequest(res, 'GET', url('/api/agents/x/terminal/stream'), { now: () => t, log: (f) => lines.push(f) })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    t = 60_000
    res.end()
    expect(lines).toEqual([])
  })
})

describe('on a real node:http server (card 12b0f698)', () => {
  it('counts the bytes handed to the response, gzip included, and keeps the response intact', async () => {
    const body = gzipSync(Buffer.from(JSON.stringify({ x: 'y'.repeat(4000) })))
    const lines: any[] = []
    const server = http.createServer((req, res) => {
      trackSlowRequest(res, req.method || 'GET', new URL(req.url || '/', 'http://localhost'), { thresholdMs: 0, log: (f) => lines.push(f) })
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
      res.end(body)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const got = await new Promise<Buffer>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/kanban?status=done' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject)
      }).on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 20))
    await new Promise<void>((r) => server.close(() => r()))
    expect(got.equals(body)).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ method: 'GET', path: '/api/kanban', query: ['status'], status: 200, bytes: body.length, complete: true })
  })
})

describe('wiring (card 12b0f698)', () => {
  it('web.ts starts the tracker for every request, before any handler can answer', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const web = readFileSync(join(root, 'src', 'web.ts'), 'utf-8')
    const handler = web.slice(web.indexOf('const server = http.createServer(async (req, res) => {'))
    const track = handler.indexOf('trackSlowRequest(res, method, url)')
    expect(track).toBeGreaterThan(-1)
    expect(track).toBeLessThan(handler.indexOf("if (method === 'OPTIONS')"))
    // web.ts resolves the principal through gateRequest() (resolveAuth runs
    // inside it, auth-gate.ts), so either call marks the auth step.
    const authAt = [handler.indexOf('resolveAuth('), handler.indexOf('gateRequest(')].filter((i) => i > -1)
    expect(authAt.length).toBeGreaterThan(0)
    expect(track).toBeLessThan(Math.min(...authAt))
  })
})
