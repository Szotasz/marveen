import type http from 'node:http'

export class BodyTooLargeError extends Error {}

/** Read a request body; past maxBytes the rest is drained (so a 413 can still be sent) and an error is thrown. */
export function readLimited(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let over = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > maxBytes) { over = true; chunks.length = 0; return }
      if (!over) chunks.push(c)
    })
    req.on('end', () => (over ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(data))
}

export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
