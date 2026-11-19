// readBoundedBytes (MIOAGENTINSTALL1114 PR-I2, plan 4.2 / M9): the ONE bounded reader of outgoing responses gives
// bytes, and readBoundedBody is that reader decoded, with the behaviour it had before.
import { describe, expect, it } from 'vitest'
import { PeerResponseTooLargeError, readBoundedBody, readBoundedBytes } from '../web/federation/http.js'

const streamOf = (parts: Uint8Array[]) => {
  let i = 0
  const s = { pulled: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (i >= parts.length) { c.close(); return } s.pulled++; c.enqueue(parts[i++]) },
    cancel() { s.cancelled = true },
  }, { highWaterMark: 0 })
  return { res: new Response(body), s }
}

describe('readBoundedBytes', () => {
  it('returns the bytes as sent, invalid UTF-8 included', async () => {
    const bytes = new Uint8Array([0x61, 0xff, 0xfe, 0x62])
    const got = await readBoundedBytes(new Response(bytes), 16)
    expect([...got]).toEqual([...bytes])
  })

  it('no body: zero bytes', async () => {
    expect((await readBoundedBytes(new Response(null), 16)).length).toBe(0)
  })

  it('exactly the limit passes; one byte over throws and cancels the stream while it reads', async () => {
    expect((await readBoundedBytes(new Response('x'.repeat(16)), 16)).length).toBe(16)
    const { res, s } = streamOf(Array.from({ length: 10 }, () => new Uint8Array(8)))
    await expect(readBoundedBytes(res, 16)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
    expect(s.pulled).toBe(3)
    expect(s.cancelled).toBe(true)
  })

  it('a declared Content-Length over the limit is refused without reading', async () => {
    const { s } = streamOf([new Uint8Array(4)])
    const res = new Response(new Uint8Array(32), { headers: { 'content-length': '32' } })
    await expect(readBoundedBytes(res, 16)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
    expect(s.pulled).toBe(0)
  })
})

describe('readBoundedBody (unchanged behaviour on top of readBoundedBytes)', () => {
  it('decodes UTF-8 and replaces an invalid sequence with U+FFFD', async () => {
    expect(await readBoundedBody(new Response('árvíztűrő'), 64)).toBe('árvíztűrő')
    expect(await readBoundedBody(new Response(new Uint8Array([0x61, 0xff])), 64)).toBe('a�')
  })

  it('no body is the empty string; over the limit throws', async () => {
    expect(await readBoundedBody(new Response(null), 8)).toBe('')
    await expect(readBoundedBody(new Response('x'.repeat(9)), 8)).rejects.toBeInstanceOf(PeerResponseTooLargeError)
  })
})
