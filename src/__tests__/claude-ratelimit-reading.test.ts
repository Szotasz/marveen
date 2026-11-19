// The last-resort header reading usage-collect.py runs (#2839): the probe result -> the windows it stores.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readingFromProbe, TOKEN_ENV } from '../claude-ratelimit-reading.js'

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0)
const nowS = Math.floor(NOW / 1000)
const w = (usedPercent: number, resetsAt: number, status: string | null = 'allowed') => ({ usedPercent, resetsAt, status })

describe('readingFromProbe', () => {
  it('a 200 with both windows: the usage endpoint keys and units', () => {
    const r = readingFromProbe({ ok: true, httpStatus: 200, usage: { fiveHour: w(35, nowS + 3600), sevenDay: w(22, nowS + 86400, 'allowed_warning'), overallStatus: 'allowed', representativeClaim: null } }, NOW)
    expect(r).toEqual({ ok: true, windows: {
      five_hour: { used_percent: 35, resets_at: nowS + 3600, status: 'allowed' },
      seven_day: { used_percent: 22, resets_at: nowS + 86400, status: 'allowed_warning' },
    } })
  })

  it('a 429 with a 5h window is still a reading', () => {
    const r = readingFromProbe({ ok: false, error: 'rate_limited', message: 'x', httpStatus: 429, usage: { fiveHour: w(100, nowS + 600, 'rejected'), sevenDay: null, overallStatus: 'rejected', representativeClaim: null } }, NOW)
    expect(r).toEqual({ ok: true, windows: { five_hour: { used_percent: 100, resets_at: nowS + 600, status: 'rejected' } } })
  })

  it('a 429 with only the 7d window rejected: exhausted until the weekly reset (the rotation rule)', () => {
    const week = nowS + 3 * 86400
    const r = readingFromProbe({ ok: false, error: 'rate_limited', message: 'x', httpStatus: 429, usage: { fiveHour: null, sevenDay: w(100, week, 'rejected'), overallStatus: 'rejected', representativeClaim: null } }, NOW)
    expect(r.ok && r.windows.five_hour).toEqual({ used_percent: 100, resets_at: week, status: 'rejected' })
  })

  it('a header-less 429 with a long retry-after reads as exhausted; a short one is no reading', () => {
    const long = readingFromProbe({ ok: false, error: 'rate_limited', message: 'x', httpStatus: 429, retryAfterSec: 900 }, NOW)
    expect(long).toEqual({ ok: true, windows: { five_hour: { used_percent: 100, resets_at: nowS + 900, status: 'rejected' } } })
    expect(readingFromProbe({ ok: false, error: 'rate_limited', message: 'x', httpStatus: 429, retryAfterSec: 30 }, NOW))
      .toEqual({ ok: false, reason: 'rate_limited (HTTP 429)' })
  })

  it('a rejected token or a network error is no reading, with a fixed reason', () => {
    expect(readingFromProbe({ ok: false, error: 'invalid_token', message: 'Token rejected (401)', httpStatus: 401 }, NOW))
      .toEqual({ ok: false, reason: 'invalid_token (HTTP 401)' })
    expect(readingFromProbe({ ok: false, error: 'network', message: 'Probe timed out' }, NOW))
      .toEqual({ ok: false, reason: 'network (HTTP -)' })
  })

  it('the token comes from the environment and is removed from it before the call', () => {
    const src = readFileSync(join(__dirname, '..', 'claude-ratelimit-reading.ts'), 'utf8')
    expect(TOKEN_ENV).toBe('CLAUDE_RATELIMIT_TOKEN')
    expect(src).toContain('delete process.env[TOKEN_ENV]')
    expect(src).not.toMatch(/process\.argv\[2\]/)
  })
})
