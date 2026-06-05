import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

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
): void {
  try {
    const stat = statSync(filePath)
    const ext = extname(filePath)
    // ETag: "<mtime_ms>-<size>" — cheap to compute, stable across identical
    // file content at the same path, and invalidated automatically on any
    // write (mtime advances). Quoted string as required by RFC 7232.
    const etag = `"${stat.mtimeMs}-${stat.size}"`
    const lastModified = stat.mtime.toUTCString()

    // RFC 7232 conditional GET: if the client has a matching ETag, serve 304.
    const ifNoneMatch = req.headers['if-none-match']
    if (etagMatches(ifNoneMatch, etag)) {
      res.writeHead(304, {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': 'no-cache',
      })
      res.end()
      return
    }

    const data = readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag,
      'Last-Modified': lastModified,
      // no-cache: revalidate on every request (not "no caching" — that is
      // no-store). Allows 304 round-trips which save bandwidth on repeated
      // loads of the same static assets.
      'Cache-Control': 'no-cache',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}
