import type { ServerResponse } from 'node:http'
import { logger } from '../logger.js'

// Card 12b0f698: one dashboard.log line for every request slower than this. After one night
// start about 79 whole-board reads (18.7 MB) held the dashboard, and nothing in the log said
// which requests were slow, how big their answers were, or who was waiting.
export const SLOW_REQUEST_MS = 2000

// A path segment the log may name as it is: a plain lowercase route word
// ("kanban", "heartbeat-summary"). Anything else -- a card id, an agent name with a
// digit, a chat id, the invite token a DELETE path carries -- is written as ":x".
const ROUTE_WORD = /^[a-z]+(?:-[a-z]+)*$/
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

// The request as the log may name it: the path with every non-route-word segment
// replaced, and the query's KEYS only (an SSE ?token= rides in a value).
export function describeRequestPath(url: URL): { path: string; query: string[] } {
  const path = url.pathname
    .split('/')
    .map((segment) => (segment === '' || (segment.length <= 40 && ROUTE_WORD.test(segment)) ? segment : ':x'))
    .join('/')
  const query: string[] = []
  for (const key of url.searchParams.keys()) {
    const named = QUERY_KEY.test(key) ? key : ':x'
    if (!query.includes(named)) query.push(named)
  }
  return { path, query }
}

type SlowLog = (fields: Record<string, unknown>, msg: string) => void

function chunkBytes(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
  if (chunk instanceof Uint8Array) return chunk.byteLength
  return 0
}

// Starts the clock for one request. The line is written once, when the response ends or
// the client goes away first (complete: false). The size is the body bytes handed to the
// response, compressed when the route compressed them. An event stream is long by design,
// not slow: it is not logged.
export function trackSlowRequest(
  res: ServerResponse,
  method: string,
  url: URL,
  opts: { now?: () => number; log?: SlowLog; thresholdMs?: number } = {},
): void {
  const now = opts.now ?? (() => performance.now())
  const log: SlowLog = opts.log ?? ((fields, msg) => logger.warn(fields, msg))
  const thresholdMs = opts.thresholdMs ?? SLOW_REQUEST_MS
  const startedAt = now()
  let bytes = 0
  // The content type as the route set it: writeHead's own headers object never reaches
  // getHeader() when nothing was set with setHeader() first (the terminal's event stream).
  let contentType = ''

  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse
  ;(res as unknown as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (...args: unknown[]) => {
    for (const arg of args.slice(1)) {
      if (Array.isArray(arg)) {
        for (let i = 0; i + 1 < arg.length; i += 2) if (String(arg[i]).toLowerCase() === 'content-type') contentType = String(arg[i + 1])
      } else if (arg && typeof arg === 'object') {
        for (const [key, value] of Object.entries(arg)) if (key.toLowerCase() === 'content-type') contentType = String(value)
      }
    }
    return writeHead(...args)
  }
  const write = res.write.bind(res) as (...args: unknown[]) => boolean
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse
  ;(res as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
    bytes += chunkBytes(args[0], args[1])
    return write(...args)
  }
  ;(res as unknown as { end: (...args: unknown[]) => ServerResponse }).end = (...args: unknown[]) => {
    if (typeof args[0] !== 'function') bytes += chunkBytes(args[0], args[1])
    return end(...args)
  }

  let logged = false
  const settle = () => {
    if (logged) return
    logged = true
    const ms = Math.round(now() - startedAt)
    if (ms < thresholdMs) return
    if ((contentType || String(res.getHeader('content-type') ?? '')).startsWith('text/event-stream')) return
    const { path, query } = describeRequestPath(url)
    log({ method, path, query, status: res.statusCode, bytes, ms, complete: res.writableFinished }, 'slow request')
  }
  res.once('finish', settle)
  res.once('close', settle)
}
