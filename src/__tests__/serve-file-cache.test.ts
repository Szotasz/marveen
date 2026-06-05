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
import http from 'node:http'
import { etagMatches, serveFile, json } from '../web/http-helpers.js'

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
