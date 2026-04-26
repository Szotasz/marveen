import http from 'node:http'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { MIME } from './atomic-write.js'

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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

export function serveFile(res: http.ServerResponse, filePath: string): void {
  try {
    const data = readFileSync(filePath)
    const ext = extname(filePath)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}
