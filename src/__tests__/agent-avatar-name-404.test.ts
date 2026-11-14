// LOW-F2-3 (self-audit): GET /api/agents/:name/avatar is public. A traversal name reached agentDir()'s safeJoin,
// which throws: the caller got a generic 500 and the server an error-level log line, at will and without a token.
// The name is now checked against AGENT_NAME_RE first and the answer is a plain 404; the gated POST does the same.
// Mutant control: without the check the handler throws, so both cases fail.
import { describe, it, expect, beforeAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

const { initDatabase } = await import('../db.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')

async function hit(method: string, path: string): Promise<number> {
  const req = Readable.from([]) as unknown as http.IncomingMessage
  req.headers = {}
  ;(req as any).url = path
  ;(req as any).method = method
  let status = 0
  const res: any = { writeHead(s: number) { status = s; return res }, setHeader() {}, end() {} }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await tryHandleAgents({ req, res, path: url.pathname, method, url, auth: { kind: 'token' } } as any, '/nonexistent')).toBe(true)
  return status
}

beforeAll(() => initDatabase(':memory:'))

describe('LOW-F2-3: a traversal agent name on the avatar route is a 404, not a thrown 500', () => {
  it('GET (public)', async () => {
    expect(await hit('GET', '/api/agents/..%2F..%2Fstore/avatar')).toBe(404)
  })
  it('POST (gated)', async () => {
    expect(await hit('POST', '/api/agents/..%2F..%2Fstore/avatar')).toBe(404)
  })
})
