/**
 * The nightly digest is timed to the next local 23:00 every time.
 * A fixed 24 h setInterval kept the first run's UTC offset, so after a
 * daylight-saving change it ran at 22:00 or 24:00 until the next restart.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { msUntilNextDigest } from '../memory.js'

const HOUR = 3600_000

beforeAll(() => {
  process.env.TZ = 'Europe/Budapest'
})

function nextRun(nowIso: string): string {
  const now = new Date(nowIso)
  return new Date(now.getTime() + msUntilNextDigest(now)).toISOString()
}

describe('msUntilNextDigest (Europe/Budapest)', () => {
  it('before 23:00 it is today at 23:00', () => {
    expect(nextRun('2026-11-02T10:00:00Z')).toBe('2026-11-02T22:00:00.000Z') // 11:00 CET -> 23:00 CET
  })

  it('at or after 23:00 it is tomorrow at 23:00', () => {
    expect(nextRun('2026-11-02T22:00:00Z')).toBe('2026-11-03T22:00:00.000Z')
    expect(nextRun('2026-11-02T22:30:00Z')).toBe('2026-11-03T22:00:00.000Z')
  })

  it('across the autumn change (25 Oct) it is still 23:00 local, 25 hours later', () => {
    // 2026-10-24 23:00:05 CEST (21:00:05Z) -> 2026-10-25 23:00 CET (22:00Z)
    const now = new Date('2026-10-24T21:00:05Z')
    expect(nextRun(now.toISOString())).toBe('2026-10-25T22:00:00.000Z')
    expect(msUntilNextDigest(now)).toBe(25 * HOUR - 5000)
  })

  it('across the spring change (28 Mar 2027) it is still 23:00 local, 23 hours later', () => {
    // 2027-03-27 23:00:05 CET (22:00:05Z) -> 2027-03-28 23:00 CEST (21:00Z)
    const now = new Date('2027-03-27T22:00:05Z')
    expect(nextRun(now.toISOString())).toBe('2027-03-28T21:00:00.000Z')
    expect(msUntilNextDigest(now)).toBe(23 * HOUR - 5000)
  })
})
