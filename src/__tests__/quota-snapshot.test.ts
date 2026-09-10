// The quota strip's whole value is that it can be trusted at a glance, so the
// reader's job is not "parse a file" but "say when the numbers may not be
// shown as current". Three ways that goes wrong, all covered here:
//
//   * no file at all -- the statusLine is not wired, or the account is an
//     API-key one that never receives a rate_limits block. The strip has to
//     say why it is absent; a silently missing strip reads as "all fine".
//   * a stale file -- the statusLine stopped writing hours ago. This is the
//     dangerous one: six-hour-old numbers look exactly like fresh ones and
//     reassure just as much, which is why age travels with the data.
//   * a window past its reset -- the block only changes when an API response
//     brings new numbers, so after a rollover the old percentage sits there
//     describing a window that no longer exists (measured at the 2026-08-18
//     22:00 rollover; scripts/lib/quota-check.py skips those for the same
//     reason).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readQuotaSnapshot, DEFAULT_MAX_AGE_SEC } from '../web/quota.js'

const NOW = 1_788_700_000

let dir: string
let file: string

function write(payload: unknown): void {
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload))
}

function healthy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    written_at: NOW - 30,
    session_id: 'test',
    rate_limits: {
      five_hour: { used_percentage: 62, resets_at: NOW + 3600 },
      seven_day: { used_percentage: 41, resets_at: NOW + 86400 },
    },
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quota-'))
  file = join(dir, '.claude-rate-limits.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('readQuotaSnapshot', () => {
  it('reports a missing file as an answer, not an error', () => {
    const snap = readQuotaSnapshot(file, NOW)
    expect(snap.status).toBe('missing')
    expect(snap.reason).toBe('no-file')
    expect(snap.fiveHour).toBeNull()
    expect(snap.ageSec).toBeNull()
  })

  it('reports a corrupt file separately from an absent one', () => {
    write('{ this is not json')
    expect(readQuotaSnapshot(file, NOW).reason).toBe('unreadable')
  })

  it('reports a payload without a rate_limits block (API-key accounts)', () => {
    write({ written_at: NOW, session_id: 'test' })
    const snap = readQuotaSnapshot(file, NOW)
    expect(snap.status).toBe('missing')
    expect(snap.reason).toBe('no-rate-limits')
  })

  it('reads both windows and the age of a fresh file', () => {
    write(healthy())
    const snap = readQuotaSnapshot(file, NOW)
    expect(snap.status).toBe('ok')
    expect(snap.ageSec).toBe(30)
    expect(snap.fiveHour).toEqual({ usedPercentage: 62, resetsAt: NOW + 3600, expired: false })
    expect(snap.sevenDay).toEqual({ usedPercentage: 41, resetsAt: NOW + 86400, expired: false })
  })

  it('marks the reading stale past the threshold instead of presenting it as current', () => {
    write(healthy({ written_at: NOW - DEFAULT_MAX_AGE_SEC - 1 }))
    const snap = readQuotaSnapshot(file, NOW)
    expect(snap.status).toBe('stale')
    expect(snap.ageSec).toBe(DEFAULT_MAX_AGE_SEC + 1)
    // the numbers still travel, so the UI can show them marked rather than
    // dropping the strip and leaving the operator with nothing
    expect(snap.fiveHour?.usedPercentage).toBe(62)
  })

  // The boundary itself, pinned: quota.ts asks `ageSec > maxAgeSec` and
  // quota-check.py asks `age > max_age`, both strict, so a reading sitting
  // exactly on the threshold is fresh on both sides. That agreement is the
  // whole reason the strip and the monitor's alert cannot contradict each
  // other, and without this assertion it holds only by coincidence -- one
  // side relaxing to `>=` would pass every other test here.
  it('treats a reading exactly at the threshold as fresh, like the monitor does', () => {
    write(healthy({ written_at: NOW - DEFAULT_MAX_AGE_SEC }))
    const snap = readQuotaSnapshot(file, NOW)
    expect(snap.status).toBe('ok')
    expect(snap.ageSec).toBe(DEFAULT_MAX_AGE_SEC)
  })

  it('honours a caller-supplied threshold, matching the monitor knob', () => {
    write(healthy({ written_at: NOW - 100 }))
    expect(readQuotaSnapshot(file, NOW, 60).status).toBe('stale')
    expect(readQuotaSnapshot(file, NOW, 600).status).toBe('ok')
  })

  it('flags a window whose reset time has already passed', () => {
    write(healthy({
      rate_limits: {
        five_hour: { used_percentage: 25, resets_at: NOW - 1 },
        seven_day: { used_percentage: 41, resets_at: NOW + 86400 },
      },
    }))
    const snap = readQuotaSnapshot(file, NOW)
    expect(snap.status).toBe('ok')
    expect(snap.fiveHour?.expired).toBe(true)
    expect(snap.sevenDay?.expired).toBe(false)
  })

  it('keeps a window that carries no reset time, without inventing one', () => {
    write(healthy({ rate_limits: { five_hour: { used_percentage: 10 } } }))
    const snap = readQuotaSnapshot(file, NOW)
    expect(snap.fiveHour).toEqual({ usedPercentage: 10, resetsAt: null, expired: false })
    expect(snap.sevenDay).toBeNull()
  })

  it('treats a missing written_at as maximally old rather than brand new', () => {
    write({ rate_limits: { five_hour: { used_percentage: 10, resets_at: NOW + 60 } } })
    expect(readQuotaSnapshot(file, NOW).status).toBe('stale')
  })
})
