import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { gzipSync } from 'node:zlib'

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

// Default upper bound on a request body the dashboard will buffer in RAM.
// Picked well above any legitimate JSON payload (the biggest legit writes
// are agent-bundle imports, which read files separately) but low enough
// that a rogue 10GB POST can't OOM the process. Callers with a tighter
// real cap (e.g. schedule endpoints cap at 256KB) pass `maxBytes`.
export const DEFAULT_READ_BODY_MAX_BYTES = 20 * 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  readonly limit: number
  constructor(limit: number) {
    super(`Request body exceeded ${limit} bytes`)
    this.name = 'RequestBodyTooLargeError'
    this.limit = limit
  }
}

export function readBody(
  req: http.IncomingMessage,
  opts: { maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? DEFAULT_READ_BODY_MAX_BYTES
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > maxBytes) {
        req.destroy()
        reject(new RequestBodyTooLargeError(maxBytes))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function json(res: http.ServerResponse, data: unknown, status = 200): void {
  // Cache-Control: private, no-store prevents CDN / proxy caching of API
  // responses that may contain user-specific data or session state. Without
  // this header, intermediate caches can serve stale or cross-user data.
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  })
  res.end(JSON.stringify(data))
}

// Compression only pays for itself on text formats above ~1KB; images are
// already compressed and tiny payloads cost more in CPU than they save.
const GZIP_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.svg'])
const GZIP_MIN_BYTES = 1024

function acceptsGzip(req: http.IncomingMessage): boolean {
  const raw = req.headers['accept-encoding']
  const value = Array.isArray(raw) ? raw.join(', ') : raw
  if (!value) return false
  // Match a gzip token that is not explicitly disabled with q=0.
  return /(^|,)\s*gzip\s*(;\s*q=(?!0(\.0*)?\s*(,|$))[\d.]+)?\s*(,|$)/i.test(value)
}

/**
 * Like json() but gzips the body when the client accepts it and the payload
 * exceeds GZIP_MIN_BYTES. Meant for the handful of heavy list endpoints
 * (kanban, messages, memories, ...) that dominate bandwidth on slow links;
 * json() itself is untouched because it has hundreds of call sites.
 */
export function jsonMaybeGzip(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  const body = Buffer.from(JSON.stringify(data))
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    Vary: 'Accept-Encoding',
  }
  if (body.length > GZIP_MIN_BYTES && acceptsGzip(req)) {
    headers['Content-Encoding'] = 'gzip'
    res.writeHead(status, headers)
    res.end(gzipSync(body))
    return
  }
  res.writeHead(status, headers)
  res.end(body)
}

// Memo of gzipped file bodies keyed by filePath + etag so hot assets (app.js
// is ~670KB) are compressed once per content version, not per request. The
// etag in the key self-invalidates on file change; the size cap bounds RAM
// (dashboard serves only a handful of distinct compressible files).
const gzipMemo = new Map<string, Buffer>()
const GZIP_MEMO_MAX_ENTRIES = 20

function gzipFileCached(filePath: string, etag: string, data: Buffer): Buffer {
  const key = `${filePath}:${etag}`
  const hit = gzipMemo.get(key)
  if (hit) return hit
  const gz = gzipSync(data)
  if (gzipMemo.size >= GZIP_MEMO_MAX_ENTRIES) {
    const oldest = gzipMemo.keys().next().value
    if (oldest !== undefined) gzipMemo.delete(oldest)
  }
  gzipMemo.set(key, gz)
  return gz
}

/**
 * Normalise an If-None-Match value for comparison with an ETag. Strips a
 * single leading W/ prefix (weak validator) so `W/"abc"` compares equal to
 * `"abc"`. Multiple W/ prefixes or bare unquoted values are left as-is
 * (malformed; the comparison will simply miss and the full response is sent).
 *
 * The header value may arrive as string[] when proxies or HTTP/1.1 clients
 * send multiple If-None-Match header lines. RFC 7230 §3.2.2 allows this and
 * the canonical interpretation is to join them with ", ". We coerce here so
 * the caller (serveFile) does not need to handle the union type explicitly,
 * and a string[] value does not throw or produce a wrong 404/500.
 */
export function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(', ') : ifNoneMatch
  const normalised = raw.startsWith('W/') ? raw.slice(2) : raw
  return normalised === etag
}

export function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  opts: { cacheSeconds?: number } = {},
): void {
  try {
    const stat = statSync(filePath)
    const ext = extname(filePath)
    // no-cache: revalidate on every request (not "no caching" -- that is
    // no-store). Allows 304 round-trips which save bandwidth on repeated
    // loads of the same static assets. Callers whose URLs are versioned or
    // whose content tolerates staleness (avatars) pass cacheSeconds so slow
    // links skip even the revalidation round-trip.
    const cacheControl = opts.cacheSeconds
      ? `private, max-age=${opts.cacheSeconds}`
      : 'no-cache'
    // ETag: "<mtime_ms>-<size>" -- cheap to compute, stable across identical
    // file content at the same path, and invalidated automatically on any
    // write (mtime advances). Quoted string as required by RFC 7232. The gzip
    // variant gets a distinct "-gz" etag so caches never hand a gzipped body
    // to a client that did not ask for it; the 304 comparison below runs
    // against the variant this client would receive.
    const wantGzip = GZIP_EXTENSIONS.has(ext) && stat.size > GZIP_MIN_BYTES && acceptsGzip(req)
    const etag = wantGzip
      ? `"${stat.mtimeMs}-${stat.size}-gz"`
      : `"${stat.mtimeMs}-${stat.size}"`
    const lastModified = stat.mtime.toUTCString()
    const varyHeaders: Record<string, string> = GZIP_EXTENSIONS.has(ext)
      ? { Vary: 'Accept-Encoding' }
      : {}

    // RFC 7232 conditional GET: if the client has a matching ETag, serve 304.
    const ifNoneMatch = req.headers['if-none-match']
    if (etagMatches(ifNoneMatch, etag)) {
      res.writeHead(304, {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
        ...varyHeaders,
      })
      res.end()
      return
    }

    const data = readFileSync(filePath)
    const body = wantGzip ? gzipFileCached(filePath, etag, data) : data
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': cacheControl,
      ...varyHeaders,
      ...(wantGzip ? { 'Content-Encoding': 'gzip' } : {}),
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}
