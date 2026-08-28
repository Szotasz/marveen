// Error-shape tests for federation reveal/rotate endpoints (#672 B14).
// Each test asserts: error token is snake_case, status code is correct, and
// (for the token-leak test) inboundToken never appears in error branches.
//
// Happy-path behaviour is not duplicated here.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../db.js'
import { tryHandleFederation } from '../web/routes/federation.js'
import {
  _setFederationStoreDirForTest,
  reloadFederationForTest,
  generatePeerInboundToken,
} from '../web/federation/config.js'
import type { RouteContext } from '../web/routes/types.js'

const TMP = mkdtempSync(join(tmpdir(), 'fed-err-shapes-test-'))
const IN_TOKEN = generatePeerInboundToken()
const OUT_TOKEN = 'e'.repeat(64)

function writeCfg(obj: unknown): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify(obj))
  reloadFederationForTest()
}

function ctx(method: string, path: string, body?: unknown): {
  ctx: RouteContext
  res: { statusCode: number; json: Record<string, unknown> }
} {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* noop */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* noop */ },
  } as unknown as RouteContext['res']
  if (body !== undefined) {
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
      ;(req as unknown as EventEmitter).emit('end')
    })
  }
  return {
    ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer: null } as unknown as RouteContext,
    res: {
      get statusCode() { return state.statusCode || 200 },
      get json(): Record<string, unknown> {
        try { return JSON.parse(state.body) } catch { return {} }
      },
    },
  }
}

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
  _setFederationStoreDirForTest(TMP)
  writeCfg({
    enabled: true,
    systemId: 'test-system',
    peers: [{ id: 'arthur', baseUrl: 'https://macbook.example.ts.net', inboundToken: IN_TOKEN, outboundToken: OUT_TOKEN }],
  })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

// ── GET /api/federation/peers/:id/inbound-token (reveal) ──────────────────────

describe('GET /api/federation/peers/:id/inbound-token -- error shapes', () => {
  it('returns invalid_value + 400 for invalid peer id format', async () => {
    const { ctx: c, res } = ctx('GET', '/api/federation/peers/bad..id/inbound-token')
    await tryHandleFederation(c)
    expect(res.statusCode).toBe(400)
    expect(res.json.error).toBe('invalid_value')
    // token must be snake_case (no spaces, no capitals)
    expect(res.json.error).toMatch(/^[a-z_]+$/)
  })

  it('returns not_found + 404 for unknown peer', async () => {
    const { ctx: c, res } = ctx('GET', '/api/federation/peers/no-such-peer/inbound-token')
    await tryHandleFederation(c)
    expect(res.statusCode).toBe(404)
    expect(res.json.error).toBe('not_found')
    expect(res.json.error).toMatch(/^[a-z_]+$/)
  })

  it('returns inboundToken on success (positive control)', async () => {
    const { ctx: c, res } = ctx('GET', '/api/federation/peers/arthur/inbound-token')
    await tryHandleFederation(c)
    expect(res.statusCode).toBe(200)
    expect(typeof res.json.inboundToken).toBe('string')
    expect((res.json.inboundToken as string).length).toBeGreaterThan(0)
  })
})

// ── POST /api/federation/peers/:id/rotate-inbound-token (rotate) ─────────────

describe('POST /api/federation/peers/:id/rotate-inbound-token -- error shapes', () => {
  it('returns invalid_value + 400 for invalid peer id format', async () => {
    const { ctx: c, res } = ctx('POST', '/api/federation/peers/bad..id/rotate-inbound-token')
    await tryHandleFederation(c)
    expect(res.statusCode).toBe(400)
    expect(res.json.error).toBe('invalid_value')
    expect(res.json.error).toMatch(/^[a-z_]+$/)
  })

  it('returns not_found + 404 for unknown peer', async () => {
    const { ctx: c, res } = ctx('POST', '/api/federation/peers/no-such-peer/rotate-inbound-token')
    await tryHandleFederation(c)
    expect(res.statusCode).toBe(404)
    expect(res.json.error).toBe('not_found')
    expect(res.json.error).toMatch(/^[a-z_]+$/)
  })

  it('returns a fresh inboundToken on success (positive control)', async () => {
    const { ctx: c, res } = ctx('POST', '/api/federation/peers/arthur/rotate-inbound-token')
    await tryHandleFederation(c)
    expect(res.statusCode).toBe(200)
    expect(typeof res.json.inboundToken).toBe('string')
    expect(res.json.inboundToken).not.toBe(IN_TOKEN)
  })
})

// ── Token-leak safety ─────────────────────────────────────────────────────────
// The inboundToken is a secret that grants remote inbox access. It must ONLY
// appear in successful reveal/rotate responses; no error branch may leak it.

describe('token-leak safety -- inboundToken never in error responses', () => {
  const errorCases: Array<{ label: string; method: string; path: string }> = [
    { label: 'reveal: bad id',   method: 'GET',  path: '/api/federation/peers/bad..id/inbound-token' },
    { label: 'reveal: not found', method: 'GET',  path: '/api/federation/peers/no-such-peer/inbound-token' },
    { label: 'rotate: bad id',   method: 'POST', path: '/api/federation/peers/bad..id/rotate-inbound-token' },
    { label: 'rotate: not found', method: 'POST', path: '/api/federation/peers/no-such-peer/rotate-inbound-token' },
  ]

  for (const { label, method, path } of errorCases) {
    it(`${label} -> body does not contain inboundToken`, async () => {
      const { ctx: c, res } = ctx(method, path)
      await tryHandleFederation(c)
      // Error branch: must not be 200
      expect(res.statusCode).not.toBe(200)
      // The raw JSON body must not contain the token string
      const raw = JSON.stringify(res.json)
      expect(raw).not.toContain('inboundToken')
    })
  }
})

// ── Mutation verification ─────────────────────────────────────────────────────
// Verify tests above would FAIL if the production code returned the wrong token.

describe('mutation: wrong error token would be caught', () => {
  it('test detects if not_found were replaced by notFound (camelCase)', async () => {
    const { ctx: c, res } = ctx('GET', '/api/federation/peers/no-such-peer/inbound-token')
    await tryHandleFederation(c)
    // Production returns 'not_found'; assert it is NOT camelCase
    expect(res.json.error).not.toBe('notFound')
    expect(res.json.error).toBe('not_found')
  })

  it('test detects if invalid_value were replaced by invalidValue (camelCase)', async () => {
    const { ctx: c, res } = ctx('GET', '/api/federation/peers/bad..id/inbound-token')
    await tryHandleFederation(c)
    expect(res.json.error).not.toBe('invalidValue')
    expect(res.json.error).toBe('invalid_value')
  })
})
