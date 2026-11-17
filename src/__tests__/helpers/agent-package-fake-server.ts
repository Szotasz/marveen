// Test helper: the in-memory publishing side and the route harness (MIOAGENTINSTALL1114, plan 10.1 last bullet).
//
// The fake server stands behind the fetchImpl seam (plan 5.2): it counts the requests, records each one's URL,
// init.redirect and headers, and answers with a body it hands out as a stream, chunk by chunk, so a test can measure
// where the reading stopped. No socket, no host: the origin is whatever the test built its Remote with.
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../../web/routes/types.js'

export const TEST_ORIGIN = 'https://packages.test'

/** A test token in the real shape: mdt_ + 43 base64url characters (32 bytes), no repeating run. */
export const TEST_TOKEN = 'mdt_' + Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64url')
export const TEST_DEVICE_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b'

export interface RecordedRequest {
  url: string
  method: string
  redirect: RequestRedirect | undefined
  headers: Record<string, string>
  body: string | undefined
  signal: AbortSignal | undefined
}

export interface Answer {
  status: number
  headers?: Record<string, string>
  /** The body in one piece. */
  body?: string | Buffer
  /** The body as separate stream chunks (takes precedence over body). */
  chunks?: Buffer[]
}

export interface StreamStats {
  /** Chunks the reader pulled out of the stream. */
  pulled: number
  /** Chunks the answer had. */
  total: number
  cancelled: boolean
}

export interface FakeServer {
  fetchImpl: typeof fetch
  requests: RecordedRequest[]
  streams: StreamStats[]
  /** The answer to the next requests (the default is a 500 with no body). */
  answer: (a: Answer | ((r: RecordedRequest) => Answer)) => void
  /** Makes the next request fail the way fetch fails (a rejected promise). */
  fail: (err: unknown) => void
}

export function makeFakeServer(): FakeServer {
  const requests: RecordedRequest[] = []
  const streams: StreamStats[] = []
  let next: (r: RecordedRequest) => Answer = () => ({ status: 500 })
  let failWith: { err: unknown } | null = null
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const r: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      redirect: init?.redirect,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal ?? undefined,
    }
    requests.push(r)
    if (failWith) throw failWith.err
    const a = next(r)
    const parts = a.chunks ?? (a.body === undefined ? [] : [Buffer.from(a.body)])
    const stats: StreamStats = { pulled: 0, total: parts.length, cancelled: false }
    streams.push(stats)
    const nullBody = a.status === 204 || a.status === 304 || (a.chunks === undefined && a.body === undefined)
    const stream = nullBody ? null : new ReadableStream<Uint8Array>({
      pull(c) {
        if (stats.pulled >= parts.length) { c.close(); return }
        c.enqueue(new Uint8Array(parts[stats.pulled++]))
      },
      cancel() { stats.cancelled = true },
    }, { highWaterMark: 0 })
    return new Response(stream, { status: a.status, headers: a.headers })
  }) as typeof fetch
  return {
    fetchImpl,
    requests,
    streams,
    answer: (a) => { failWith = null; next = typeof a === 'function' ? a : () => a },
    fail: (err) => { failWith = { err } },
  }
}

export interface CallOut {
  status: number
  /** The raw response body. */
  raw: string
  body: any
  /** Every header the route wrote (writeHead and setHeader), as "name: value" lines. */
  headers: string[]
}

type Handler = (ctx: RouteContext) => Promise<boolean>

/** One request through a route handler, with a fake req/res. `body` is sent as given (a string is not re-encoded). */
export async function callRoute(
  handler: Handler,
  method: string,
  path: string,
  auth: RouteContext['auth'],
  body?: unknown,
  reqHeaders: Record<string, string> = {},
): Promise<{ handled: boolean; out: CallOut }> {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = reqHeaders
  ;(req as any).url = path
  ;(req as any).method = method
  const out: CallOut = { status: 0, raw: '', body: null, headers: [] }
  const addHeaders = (h: unknown) => {
    if (h && typeof h === 'object') for (const [k, v] of Object.entries(h as Record<string, unknown>)) out.headers.push(`${k}: ${String(v)}`)
  }
  const res: any = {
    writeHead(s: number, h?: unknown) { out.status = s; addHeaders(h); return res },
    setHeader(k: string, v: unknown) { out.headers.push(`${k}: ${String(v)}`) },
    end(c?: string | Buffer) {
      if (c !== undefined) {
        out.raw += c.toString()
        try { out.body = JSON.parse(out.raw) } catch { out.body = out.raw }
      }
    },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const handled = await handler({ req, res: res as http.ServerResponse, path: url.pathname, method, url, auth })
  if (out.status === 0) out.status = 200
  return { handled, out }
}

/** Every string inside a value: object keys and values, array items, Error message/stack/cause, at any depth. */
export function stringsIn(v: unknown, seen = new Set<unknown>()): string[] {
  if (typeof v === 'string') return [v]
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return [String(v)]
  if (v === null || v === undefined || typeof v !== 'object' || seen.has(v)) return []
  seen.add(v)
  const out: string[] = []
  if (v instanceof Error) out.push(v.name, v.message, v.stack ?? '', ...stringsIn((v as { cause?: unknown }).cause, seen))
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k === 'string') out.push(k)
    out.push(...stringsIn((v as Record<string | symbol, unknown>)[k], seen))
  }
  return out
}

/** The token and every 8-character piece of it (T1: a quoted fragment is a leak too). */
export function tokenPieces(token: string): string[] {
  const pieces = new Set<string>([token])
  for (let i = 0; i + 8 <= token.length; i++) pieces.add(token.slice(i, i + 8))
  return [...pieces]
}

/** The pieces of `token` found in `texts`, each with the first text that holds it (empty when none leaked). */
export function leaksIn(texts: readonly string[], token: string): string[] {
  const hits: string[] = []
  for (const p of tokenPieces(token)) {
    const t = texts.find((x) => x.includes(p))
    if (t !== undefined) hits.push(`${p} in ${JSON.stringify(t.slice(0, 120))}`)
  }
  return hits
}
