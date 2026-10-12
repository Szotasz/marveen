// Contract tests for serveFile cache headers and etagMatches helper.
//
// Root cause: the pre-fix serveFile sent only Content-Type with no ETag,
// no Last-Modified, and no Cache-Control. The json() helper also sent no
// Cache-Control, allowing intermediate proxies to cache API responses.
//
// Fix:
//   - serveFile(req, res, path) now: sends Cache-Control: no-cache, ETag,
//     Last-Modified; honours If-None-Match with a 304 response.
//   - etagMatches(ifNoneMatch, etag) normalises W/ prefix.
//   - json() adds Cache-Control: private, no-store.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'
import { etagMatches, serveFile, json, jsonMaybeGzip } from '../web/http-helpers.js'

// ---------------------------------------------------------------------------
// json() Cache-Control contract test
// ---------------------------------------------------------------------------
describe('json() cache headers', () => {
  it('sends Cache-Control: private, no-store on every json() response', () => {
    // Intermediate proxies must never cache API responses that may contain
    // user-specific data or session state. json() must set the header on
    // every call regardless of status code.
    let capturedStatus: number | null = null
    const capturedHeaders: Record<string, string | string[]> = {}
    let capturedBody: string | null = null
    const res = {
      writeHead(status: number, hdrs?: Record<string, string | string[]>) {
        capturedStatus = status
        if (hdrs) Object.assign(capturedHeaders, hdrs)
      },
      end(data?: string) { capturedBody = data ?? null },
    } as unknown as http.ServerResponse

    json(res, { ok: true })
    expect(capturedStatus).toBe(200)
    const cc = (capturedHeaders['Cache-Control'] ?? capturedHeaders['cache-control']) as string
    expect(cc).toBe('private, no-store')
    expect(capturedBody).toBe(JSON.stringify({ ok: true }))
  })
})

// ---------------------------------------------------------------------------
// etagMatches unit tests (pure function, no I/O)
// ---------------------------------------------------------------------------
describe('etagMatches', () => {
  it('returns false when ifNoneMatch is undefined', () => {
    expect(etagMatches(undefined, '"abc-123"')).toBe(false)
  })

  it('returns true for an exact match', () => {
    expect(etagMatches('"abc-123"', '"abc-123"')).toBe(true)
  })

  it('returns false for a mismatch', () => {
    expect(etagMatches('"abc-123"', '"def-456"')).toBe(false)
  })

  it('normalises W/ prefix before comparing', () => {
    expect(etagMatches('W/"abc-123"', '"abc-123"')).toBe(true)
  })

  it('does not normalise double W/ prefix (malformed → miss)', () => {
    expect(etagMatches('W/W/"abc-123"', '"abc-123"')).toBe(false)
  })

  it('coerces string[] to RFC-joined string before comparing', () => {
    // HTTP/1.1 proxies may send duplicate If-None-Match header lines, which
    // Node.js surfaces as string[]. Without coercion the array would be
    // passed to startsWith() and throw a TypeError, yielding a 500.
    // RFC 7230 §3.2.2 canonical join is ", ".
    expect(etagMatches(['"abc-123"'], '"abc-123"')).toBe(true)
    expect(etagMatches(['W/"abc-123"'], '"abc-123"')).toBe(true)
    expect(etagMatches(['"abc-123"', '"def-456"'], '"abc-123"')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// serveFile cache-header contract test (calls real serveFile entry point)
// ---------------------------------------------------------------------------

let tmpDir: string
let testFile: string

beforeAll(() => {
  tmpDir = join(tmpdir(), `serve-file-cache-test-${process.pid}`)
  mkdirSync(tmpDir, { recursive: true })
  testFile = join(tmpDir, 'test.html')
  writeFileSync(testFile, '<html>hello</html>')
})

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

function fakeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  // Minimal IncomingMessage-like object sufficient for serveFile's header reads.
  return { headers } as unknown as http.IncomingMessage
}

function fakeRes(): {
  res: http.ServerResponse
  statusCode: number | null
  headers: Record<string, string | string[]>
  body: Buffer | null
} {
  const captured: {
    statusCode: number | null
    headers: Record<string, string | string[]>
    body: Buffer | null
  } = { statusCode: null, headers: {}, body: null }

  const res = {
    writeHead(status: number, hdrs?: Record<string, string | string[]>) {
      captured.statusCode = status
      if (hdrs) Object.assign(captured.headers, hdrs)
    },
    end(data?: Buffer | string) {
      captured.body = data ? Buffer.from(data) : Buffer.alloc(0)
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value
    },
  } as unknown as http.ServerResponse

  return { res, ...captured, get statusCode() { return captured.statusCode }, get headers() { return captured.headers }, get body() { return captured.body } }
}

describe('serveFile cache headers', () => {
  it('serves 200 with ETag, Last-Modified and Cache-Control: no-cache on first request', () => {
    const req = fakeReq()
    const cap = fakeRes()
    serveFile(req, cap.res, testFile)
    expect(cap.statusCode).toBe(200)
    expect(typeof cap.headers['ETag'] === 'string' || typeof cap.headers['etag'] === 'string').toBe(true)
    const etag = (cap.headers['ETag'] ?? cap.headers['etag']) as string
    expect(etag).toMatch(/^"[\d.]+-\d+"$/)
    expect(cap.headers['Last-Modified'] ?? cap.headers['last-modified']).toBeTruthy()
    const cc = (cap.headers['Cache-Control'] ?? cap.headers['cache-control']) as string
    expect(cc).toBe('no-cache')
  })

  it('serves 304 with matching If-None-Match (conditional GET)', () => {
    // First: get the ETag
    const req1 = fakeReq()
    const cap1 = fakeRes()
    serveFile(req1, cap1.res, testFile)
    const etag = (cap1.headers['ETag'] ?? cap1.headers['etag']) as string

    // Second: send If-None-Match matching the ETag
    const req2 = fakeReq({ 'if-none-match': etag })
    const cap2 = fakeRes()
    serveFile(req2, cap2.res, testFile)
    expect(cap2.statusCode).toBe(304)
    // 304 body must be empty
    expect(cap2.body?.length).toBe(0)
  })

  it('serves 200 with non-matching If-None-Match (stale ETag)', () => {
    const req = fakeReq({ 'if-none-match': '"stale-etag-000"' })
    const cap = fakeRes()
    serveFile(req, cap.res, testFile)
    expect(cap.statusCode).toBe(200)
  })

  it('serves 304 with matching W/ weak ETag', () => {
    const req1 = fakeReq()
    const cap1 = fakeRes()
    serveFile(req1, cap1.res, testFile)
    const etag = (cap1.headers['ETag'] ?? cap1.headers['etag']) as string

    const req2 = fakeReq({ 'if-none-match': `W/${etag}` })
    const cap2 = fakeRes()
    serveFile(req2, cap2.res, testFile)
    expect(cap2.statusCode).toBe(304)
  })

  it('serves 404 for a non-existent file', () => {
    const req = fakeReq()
    const cap = fakeRes()
    serveFile(req, cap.res, join(tmpDir, 'does-not-exist.html'))
    expect(cap.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// serveFile cacheSeconds + gzip contract tests
// ---------------------------------------------------------------------------

function header(cap: ReturnType<typeof fakeRes>, name: string): string | undefined {
  return (cap.headers[name] ?? cap.headers[name.toLowerCase()]) as string | undefined
}

describe('serveFile cacheSeconds option', () => {
  it('sends private max-age instead of no-cache when cacheSeconds is set', () => {
    const cap = fakeRes()
    serveFile(fakeReq(), cap.res, testFile, { cacheSeconds: 3600 })
    expect(cap.statusCode).toBe(200)
    expect(header(cap, 'Cache-Control')).toBe('private, max-age=3600')
  })

  it('keeps max-age on the 304 revalidation response', () => {
    const cap1 = fakeRes()
    serveFile(fakeReq(), cap1.res, testFile, { cacheSeconds: 3600 })
    const etag = header(cap1, 'ETag') as string

    const cap2 = fakeRes()
    serveFile(fakeReq({ 'if-none-match': etag }), cap2.res, testFile, { cacheSeconds: 3600 })
    expect(cap2.statusCode).toBe(304)
    expect(header(cap2, 'Cache-Control')).toBe('private, max-age=3600')
  })
})

describe('serveFile gzip', () => {
  let bigJsFile: string
  let bigPngFile: string
  const bigContent = `// filler\n${'const x = 1;\n'.repeat(500)}`

  beforeAll(() => {
    bigJsFile = join(tmpDir, 'big.js')
    writeFileSync(bigJsFile, bigContent)
    // Same size but a non-compressible extension: must never be gzipped.
    bigPngFile = join(tmpDir, 'big.png')
    writeFileSync(bigPngFile, bigContent)
  })

  it('gzips a large compressible file when the client accepts gzip', () => {
    const cap = fakeRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip, deflate, br' }), cap.res, bigJsFile)
    expect(cap.statusCode).toBe(200)
    expect(header(cap, 'Content-Encoding')).toBe('gzip')
    expect(header(cap, 'Vary')).toBe('Accept-Encoding')
    expect(header(cap, 'ETag')).toMatch(/-gz"$/)
    expect(gunzipSync(cap.body as Buffer).toString()).toBe(bigContent)
  })

  it('does not gzip without Accept-Encoding and keeps the plain ETag format', () => {
    const cap = fakeRes()
    serveFile(fakeReq(), cap.res, bigJsFile)
    expect(cap.statusCode).toBe(200)
    expect(header(cap, 'Content-Encoding')).toBeUndefined()
    expect(header(cap, 'ETag')).toMatch(/^"[\d.]+-\d+"$/)
    expect((cap.body as Buffer).toString()).toBe(bigContent)
  })

  it('does not gzip when the client disables gzip with q=0', () => {
    const cap = fakeRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip;q=0, identity' }), cap.res, bigJsFile)
    expect(header(cap, 'Content-Encoding')).toBeUndefined()
  })

  it('does not gzip non-compressible extensions', () => {
    const cap = fakeRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, bigPngFile)
    expect(header(cap, 'Content-Encoding')).toBeUndefined()
    expect(header(cap, 'Vary')).toBeUndefined()
  })

  it('does not gzip small compressible files', () => {
    const cap = fakeRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, testFile)
    expect(header(cap, 'Content-Encoding')).toBeUndefined()
  })

  it('serves 304 against the gzip-variant ETag for a gzip-accepting client', () => {
    const cap1 = fakeRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap1.res, bigJsFile)
    const gzEtag = header(cap1, 'ETag') as string
    expect(gzEtag).toMatch(/-gz"$/)

    const cap2 = fakeRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip', 'if-none-match': gzEtag }), cap2.res, bigJsFile)
    expect(cap2.statusCode).toBe(304)
    expect(cap2.body?.length).toBe(0)
  })

  it('does not 304 a non-gzip client holding the gzip-variant ETag', () => {
    // A cache entry stored from a gzip response must not satisfy a client
    // that no longer accepts gzip: the etags differ, so the full plain body
    // is served again.
    const cap1 = fakeRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap1.res, bigJsFile)
    const gzEtag = header(cap1, 'ETag') as string

    const cap2 = fakeRes()
    serveFile(fakeReq({ 'if-none-match': gzEtag }), cap2.res, bigJsFile)
    expect(cap2.statusCode).toBe(200)
    expect(header(cap2, 'Content-Encoding')).toBeUndefined()
  })
})

describe('jsonMaybeGzip', () => {
  const bigData = { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: `row number ${i} with some padding text` })) }

  it('gzips a large payload for a gzip-accepting client', () => {
    const cap = fakeRes()
    jsonMaybeGzip(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, bigData)
    expect(cap.statusCode).toBe(200)
    expect(header(cap, 'Content-Encoding')).toBe('gzip')
    expect(header(cap, 'Vary')).toBe('Accept-Encoding')
    expect(header(cap, 'Cache-Control')).toBe('private, no-store')
    expect(JSON.parse(gunzipSync(cap.body as Buffer).toString())).toEqual(bigData)
  })

  it('sends plain JSON without Accept-Encoding', () => {
    const cap = fakeRes()
    jsonMaybeGzip(fakeReq(), cap.res, bigData)
    expect(header(cap, 'Content-Encoding')).toBeUndefined()
    expect(JSON.parse((cap.body as Buffer).toString())).toEqual(bigData)
  })

  it('sends small payloads uncompressed even when gzip is accepted', () => {
    const cap = fakeRes()
    jsonMaybeGzip(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, { ok: true })
    expect(header(cap, 'Content-Encoding')).toBeUndefined()
    expect(JSON.parse((cap.body as Buffer).toString())).toEqual({ ok: true })
  })

  it('honours a non-200 status', () => {
    const cap = fakeRes()
    jsonMaybeGzip(fakeReq(), cap.res, { error: 'nope' }, 500)
    expect(cap.statusCode).toBe(500)
  })
})
