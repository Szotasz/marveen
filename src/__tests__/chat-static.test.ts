import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import { tryHandleChatStatic } from '../web/routes/chat-static.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status?: number; body: string } } {
  const out: { status?: number; body: string } = { body: '' }
  const res = {
    writeHead(status: number) { out.status = status; return this },
    end(chunk?: unknown) { if (chunk) out.body += String(chunk) },
    setHeader() { /* noop */ },
  } as unknown as http.ServerResponse
  const req = { headers: {} } as http.IncomingMessage
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`) }, out }
}

// CHAT_APP_ENABLED is read from .env at import time; in the test environment
// it is off, so the route must answer the whitelisted paths with 404 and
// still ignore everything else. The whitelist itself (no traversal) is the
// security property under test.
describe('tryHandleChatStatic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-web-'))
  writeFileSync(join(dir, 'index.html'), '<html></html>')

  it('ignores non-chat paths (falls through to the next route)', async () => {
    const { ctx } = fakeCtx('/api/agents')
    expect(await tryHandleChatStatic(ctx, dir)).toBe(false)
  })

  it('refuses path traversal shapes by whitelist (not by sanitising)', async () => {
    for (const p of ['/chat/../store/.dashboard-token', '/chat/%2e%2e/secret', '/chat/sub/file.js']) {
      const { ctx } = fakeCtx(p)
      expect(await tryHandleChatStatic(ctx, dir)).toBe(false)
    }
  })

  it('answers whitelisted paths (404 while the feature flag is off)', async () => {
    const { ctx, out } = fakeCtx('/chat/')
    expect(await tryHandleChatStatic(ctx, dir)).toBe(true)
    expect(out.status).toBe(404)
  })
})
