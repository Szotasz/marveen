import { describe, it, expect } from 'vitest'

// These functions don't exist yet → RED
import { issueTicket, consumeTicket, checkRateLimit } from '../web/pty-ticket.js'

describe('issueTicket', () => {
  it('returns a 64-char hex string', () => {
    const t = issueTicket('cody', 1000)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns unique tickets per call', () => {
    const t1 = issueTicket('cody', 1000)
    const t2 = issueTicket('cody', 1000)
    expect(t1).not.toBe(t2)
  })
})

describe('consumeTicket', () => {
  it('happy path: fresh unused ticket', () => {
    const t = issueTicket('cody', 1000)
    const result = consumeTicket(t, 1010)
    expect(result).toEqual({ ok: true, agentName: 'cody' })
  })

  it('expired TTL (30s) returns { ok: false, reason: "expired" }', () => {
    const t = issueTicket('cody', 1000)
    const result = consumeTicket(t, 1031) // 31s later
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('exactly at 30s boundary is expired', () => {
    const t = issueTicket('cody', 1000)
    const result = consumeTicket(t, 1030) // exactly 30s
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('within 30s is valid', () => {
    const t = issueTicket('cody', 1000)
    const result = consumeTicket(t, 1029) // 29s
    expect(result.ok).toBe(true)
  })

  it('second consume of same ticket returns already_used', () => {
    const t = issueTicket('cody', 1000)
    consumeTicket(t, 1010)
    const result = consumeTicket(t, 1010)
    expect(result).toEqual({ ok: false, reason: 'already_used' })
  })

  it('unknown ticket returns not_found', () => {
    const result = consumeTicket('a'.repeat(64), 1000)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('checkRateLimit', () => {
  it('first 10 requests from same IP are ok', () => {
    const ip = `ip-test-${Date.now()}` // unique IP to avoid cross-test interference
    const now = 1000000
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(ip, now + i)).toEqual({ ok: true })
    }
  })

  it('11th request within 60s window returns not-ok with retry_after_s', () => {
    const ip = `ip-rate-${Date.now()}`
    const now = 2000000
    for (let i = 0; i < 10; i++) checkRateLimit(ip, now)
    const result = checkRateLimit(ip, now + 5)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retry_after_s).toBeGreaterThan(0)
      expect(result.retry_after_s).toBeLessThanOrEqual(60)
    }
  })

  it('resets after 60s window elapses', () => {
    const ip = `ip-reset-${Date.now()}`
    const now = 3000000
    for (let i = 0; i < 10; i++) checkRateLimit(ip, now)
    // 61s later, new window
    const result = checkRateLimit(ip, now + 61)
    expect(result).toEqual({ ok: true })
  })
})
