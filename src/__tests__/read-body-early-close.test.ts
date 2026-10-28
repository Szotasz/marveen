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
// Fix: readBody also rejects on a 'close' that arrives before 'end'. A normal
// request still resolves with the full body ('close' after 'end' is a no-op).
//
// Every outcome goes through one settled guard, and the over-limit rejection
// is recorded BEFORE req.destroy(): on Node 22 destroy() emits 'aborted'
// synchronously and 'close' right after, and a listener reacting to them must
// not replace RequestBodyTooLargeError (routes answer 413 on instanceof) or the
// socket error of a client disconnect.

import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readBody, RequestBodyTooLargeError } from '../web/http-helpers.js'

type Outcome =
  | { kind: 'resolved'; body: string }
  | { kind: 'rejected'; message: string; error: unknown }
  | { kind: 'pending' }

function settleWithin(p: Promise<Buffer>, ms: number): Promise<Outcome> {
  return Promise.race([
    p.then(
      (b): Outcome => ({ kind: 'resolved', body: b.toString('utf8') }),
      (e: unknown): Outcome => ({ kind: 'rejected', message: e instanceof Error ? e.message : String(e), error: e }),
    ),
    new Promise<Outcome>((r) => setTimeout(() => r({ kind: 'pending' }), ms)),
  ])
}

function fakeRequest(): http.IncomingMessage & EventEmitter {
  const req = new EventEmitter() as unknown as http.IncomingMessage & EventEmitter
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  return req
}

// destroy() the way Node 22's IncomingMessage does it on an unfinished body:
// 'aborted' synchronously inside the call, 'close' on the next tick.
function nodeLikeRequest(): http.IncomingMessage & EventEmitter {
  const req = new EventEmitter() as unknown as http.IncomingMessage & EventEmitter
  ;(req as unknown as { destroy: () => void }).destroy = () => {
    req.emit('aborted')
    process.nextTick(() => req.emit('close'))
  }
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

  it('rejects on aborted followed by close (the order Node emits them)', async () => {
    const req = fakeRequest()
    const p = readBody(req)
    req.emit('data', Buffer.from('{"partial":'))
    req.emit('aborted')
    req.emit('close')
    const out = await settleWithin(p, 500)
    expect(out.kind).toBe('rejected')
  })

  it('over the limit, rejects with RequestBodyTooLargeError even though destroy() emits aborted/close', async () => {
    const req = nodeLikeRequest()
    const p = readBody(req, { maxBytes: 8 })
    req.emit('data', Buffer.from('0123456789'))
    const out = await settleWithin(p, 500)
    expect(out.kind).toBe('rejected')
    if (out.kind !== 'rejected') return
    expect(out.error).toBeInstanceOf(RequestBodyTooLargeError)
    expect((out.error as RequestBodyTooLargeError).limit).toBe(8)
  })

  it('keeps the first error when close follows it', async () => {
    const req = fakeRequest()
    const p = readBody(req)
    const boom = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    req.emit('data', Buffer.from('{"partial":'))
    req.emit('error', boom)
    req.emit('close')
    const out = await settleWithin(p, 500)
    expect(out.kind === 'rejected' && out.error).toBe(boom)
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
    // The socket error itself, not a generic early-close Error raised from the
    // 'aborted' that Node emits just before it.
    expect(out.kind === 'rejected' && (out.error as NodeJS.ErrnoException).code).toBe('ECONNRESET')
  })

  it('rejects a chunked body over maxBytes with RequestBodyTooLargeError', async () => {
    let outcome: Promise<Outcome> | null = null
    const handlerReached = new Promise<void>((reached) => {
      server = http.createServer((req) => {
        outcome = settleWithin(readBody(req, { maxBytes: 1024 }), 2000)
        reached()
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const { port } = server!.address() as AddressInfo

    // No Content-Length: Transfer-Encoding chunked, so only readBody's own
    // byte count can catch the overflow.
    const client = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' })
    client.on('error', () => {})
    try {
      client.write('x'.repeat(512))
      await handlerReached
      for (let i = 0; i < 8; i++) client.write('y'.repeat(512))
      const out = await outcome!
      expect(out.kind).toBe('rejected')
      if (out.kind !== 'rejected') return
      expect(out.error).toBeInstanceOf(RequestBodyTooLargeError)
      expect((out.error as RequestBodyTooLargeError).limit).toBe(1024)
    } finally {
      client.destroy()
    }
  })

  it('settles when the request is destroyed server-side without an error', async () => {
    let outcome: Promise<Outcome> | null = null
    const handlerReached = new Promise<void>((reached) => {
      server = http.createServer((req) => {
        outcome = settleWithin(readBody(req), 2000)
        reached()
        setTimeout(() => req.destroy(), 20)
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
    try {
      client.write('{"partial":')
      await handlerReached
      const out = await outcome!
      expect(out.kind).toBe('rejected')
    } finally {
      client.destroy()
    }
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
