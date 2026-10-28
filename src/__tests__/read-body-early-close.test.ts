// readBody() must settle when the request ends without 'end'.
//
// readBody only listened for 'end' and 'error'. Measured on Node 22: a client
// that disconnects mid-body (or a stalled client cut by requestTimeout) gets
// 'aborted', 'error' (ECONNRESET), 'close', so the 'error' listener already
// rejects. But a request destroyed WITHOUT an error -- req.destroy() from any
// other code path while a route is still awaiting the body -- emits only
// 'aborted' and 'close', and the promise never settles: the route handler
// awaiting it hangs for good and keeps its closures alive.
//
// Fix: readBody also rejects on 'aborted' and on a 'close' that arrives before
// 'end'. A normal request still resolves with the full body ('close' after
// 'end' is a no-op).

import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readBody } from '../web/http-helpers.js'

type Outcome = { kind: 'resolved'; body: string } | { kind: 'rejected'; message: string } | { kind: 'pending' }

function settleWithin(p: Promise<Buffer>, ms: number): Promise<Outcome> {
  return Promise.race([
    p.then(
      (b): Outcome => ({ kind: 'resolved', body: b.toString('utf8') }),
      (e: unknown): Outcome => ({ kind: 'rejected', message: e instanceof Error ? e.message : String(e) }),
    ),
    new Promise<Outcome>((r) => setTimeout(() => r({ kind: 'pending' }), ms)),
  ])
}

function fakeRequest(): http.IncomingMessage & EventEmitter {
  const req = new EventEmitter() as unknown as http.IncomingMessage & EventEmitter
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  return req
}

describe('readBody on a fake request', () => {
  it('rejects when the request closes before end, with no error event', async () => {
    const req = fakeRequest()
    const p = readBody(req)
    req.emit('data', Buffer.from('{"partial":'))
    req.emit('close')
    const out = await settleWithin(p, 500)
    expect(out.kind).toBe('rejected')
  })

  it('rejects on aborted', async () => {
    const req = fakeRequest()
    const p = readBody(req)
    req.emit('data', Buffer.from('{"partial":'))
    req.emit('aborted')
    const out = await settleWithin(p, 500)
    expect(out.kind).toBe('rejected')
  })

  it('still resolves with the full body when close follows end', async () => {
    const req = fakeRequest()
    const p = readBody(req)
    req.emit('data', Buffer.from('{"a":'))
    req.emit('data', Buffer.from('1}'))
    req.emit('end')
    req.emit('close')
    const out = await settleWithin(p, 500)
    expect(out).toEqual({ kind: 'resolved', body: '{"a":1}' })
  })
})

describe('readBody on a real socket', () => {
  let server: http.Server | null = null
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = null
  })

  it('settles when the client disconnects mid-body', async () => {
    let outcome: Promise<Outcome> | null = null
    const handlerReached = new Promise<void>((reached) => {
      server = http.createServer((req) => {
        outcome = settleWithin(readBody(req), 2000)
        reached()
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const { port } = server!.address() as AddressInfo

    const client = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' },
    })
    client.on('error', () => {})
    client.write('{"partial":')
    await handlerReached
    client.destroy()

    const out = await outcome!
    expect(out.kind).toBe('rejected')
  })

  it('settles when the request is destroyed server-side without an error', async () => {
    let outcome: Promise<Outcome> | null = null
    server = http.createServer((req) => {
      outcome = settleWithin(readBody(req), 2000)
      setTimeout(() => req.destroy(), 20)
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const { port } = server!.address() as AddressInfo

    const client = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' },
    })
    client.on('error', () => {})
    client.write('{"partial":')
    await new Promise<void>((r) => { const t = setInterval(() => { if (outcome) { clearInterval(t); r() } }, 5) })

    const out = await outcome!
    expect(out.kind).toBe('rejected')
    client.destroy()
  })

  it('resolves a complete body', async () => {
    let outcome: Promise<Outcome> | null = null
    server = http.createServer((req, res) => {
      outcome = settleWithin(readBody(req), 2000)
      outcome.then(() => res.end('ok'))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const { port } = server!.address() as AddressInfo

    await new Promise<void>((done, fail) => {
      const client = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' } },
        (res) => { res.resume(); res.on('end', () => done()) },
      )
      client.on('error', fail)
      client.end('{"a":1}')
    })

    expect(await outcome!).toEqual({ kind: 'resolved', body: '{"a":1}' })
  })
})
