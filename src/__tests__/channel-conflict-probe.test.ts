// Unit tests for the Telegram 409-Conflict diagnostic probe added per Szabi's
// 2026-06-01 request. The probe runs ONCE per down-cycle and writes the
// upstream cause to dashboard.log so an operator can distinguish the orphan
// poller race from a real network/hardware failure.

import { describe, it, expect, afterEach } from 'vitest'
import { probeTelegramConflict } from '../web/channel-conflict-probe.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockJsonResponse(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('probeTelegramConflict', () => {
  it('returns conflicted=true with the description when Telegram answers 409', async () => {
    // Real Telegram body for this case, verbatim.
    globalThis.fetch = mockJsonResponse(409, {
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
    })
    const r = await probeTelegramConflict('test-token')
    expect(r.conflicted).toBe(true)
    expect(r.status).toBe(409)
    expect(r.description).toMatch(/Conflict.*other getUpdates request/)
  })

  it('returns conflicted=false on 200 OK (normal poll succeeded)', async () => {
    globalThis.fetch = mockJsonResponse(200, { ok: true, result: [] })
    const r = await probeTelegramConflict('test-token')
    expect(r.conflicted).toBe(false)
    expect(r.status).toBe(200)
  })

  it('returns conflicted=false on 401 unauthorized (rotated/revoked token, NOT orphan)', async () => {
    // Distinguish a 401 from a 409 so the operator does not chase the orphan
    // path when the actual issue is a bad token.
    globalThis.fetch = mockJsonResponse(401, {
      ok: false, error_code: 401, description: 'Unauthorized',
    })
    const r = await probeTelegramConflict('bad-token')
    expect(r.conflicted).toBe(false)
    expect(r.status).toBe(401)
    expect(r.description).toBe('Unauthorized')
  })

  it('returns conflicted=false on network failure without throwing', async () => {
    // The probe runs on the dashboard's sync check loop. A network exception
    // must not propagate.
    globalThis.fetch = (async () => { throw new Error('network unreachable') }) as unknown as typeof fetch
    const r = await probeTelegramConflict('test-token')
    expect(r.conflicted).toBe(false)
    expect(r.status).toBe(0)
    expect(r.description).toBeNull()
  })

  it('returns conflicted=false on empty token (cheap guard, no HTTP call)', async () => {
    let called = false
    globalThis.fetch = (async () => { called = true; return new Response('', { status: 200 }) }) as unknown as typeof fetch
    const r = await probeTelegramConflict('')
    expect(r.conflicted).toBe(false)
    expect(called).toBe(false)
  })

  it('tolerates a non-JSON 409 body (proxy/CDN interposition)', async () => {
    // Defensive: still classifies as conflicted on status alone even if the
    // body cannot be parsed as JSON.
    globalThis.fetch = (async () => new Response('<html>cf error</html>', {
      status: 409,
      headers: { 'Content-Type': 'text/html' },
    })) as unknown as typeof fetch
    const r = await probeTelegramConflict('test-token')
    expect(r.conflicted).toBe(true)
    expect(r.status).toBe(409)
    // description may be null because body was not JSON - that's fine
  })
})
