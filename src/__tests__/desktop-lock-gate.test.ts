// Desktop-lock gate: only screen-driving rounds wait, the skip is recorded,
// and the lock expires.
//
// Background: the fleet's "I am driving the screen" lock was a convention --
// a broadcast the other agents were expected to respect. The scheduler could
// not respect anything, so it fired GUI rounds into a session already driving
// the same screen. Making it machine-readable brought three requirements, and
// each one has a test below:
//
//   1. Only tasks that NEED the desktop wait. A blanket suspension would
//      produce blanket silence, and silence is what nobody questions.
//   2. A skipped round is never silent -- an untraced dropped tick looks
//      exactly like "there was nothing to do".
//   3. The lock expires, or one dead holder parks the fleet indefinitely.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideDesktopGate, lockExpiresAt, readDesktopLock, writeDesktopLock, clearDesktopLock,
  recordDesktopSkip, TTL_GRACE_MS, DEFAULT_ESTIMATE_MS, type DesktopLock, type DesktopSkipRecord,
} from '../web/desktop-lock.js'

const NOW = 1_785_855_000_000

function lock(over: Partial<DesktopLock> = {}): DesktopLock {
  return {
    owner: 'janna',
    acquiredAt: NOW,
    estimatedEndAt: NOW + 20 * 60_000,
    estimateProvided: true,
    ...over,
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'desktop-lock-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('decideDesktopGate', () => {
  it('lets a task that does not need the screen run under a live lock', () => {
    const d = decideDesktopGate({ requiresDesktop: false, lock: lock(), now: NOW + 60_000, agent: 'taric' })
    expect(d.action).toBe('run')
  })

  it('runs when nobody holds the lock', () => {
    expect(decideDesktopGate({ requiresDesktop: true, lock: null, now: NOW, agent: 'taric' }).action).toBe('run')
  })

  it('skips a screen-driving task while someone else holds the lock', () => {
    const d = decideDesktopGate({ requiresDesktop: true, lock: lock(), now: NOW + 60_000, agent: 'taric' })
    expect(d.action).toBe('skip')
    expect(d.lockOwner).toBe('janna')
    // The reason is written verbatim into the skip record, so it has to carry
    // the two facts a later reader needs: who, and for how long.
    expect(d.reason).toContain('janna')
    expect(d.reason).toMatch(/\d+ more min/)
  })

  // The holder must not be blocked by its own lock -- that would deadlock the
  // very round the lock was taken for.
  it('does not gate the holder against itself', () => {
    const d = decideDesktopGate({ requiresDesktop: true, lock: lock(), now: NOW + 60_000, agent: 'janna' })
    expect(d.action).toBe('run')
  })

  it('opens the gate once the lock expires, and says so', () => {
    const l = lock()
    const d = decideDesktopGate({ requiresDesktop: true, lock: l, now: lockExpiresAt(l) + 60_000, agent: 'taric' })
    expect(d.action).toBe('run-lock-expired')
    expect(d.reason).toContain('expired')
    expect(d.reason).toContain('janna')
  })

  it('still holds during the grace period, not only until the estimate', () => {
    const l = lock()
    const justAfterEstimate = (l.estimatedEndAt as number) + 60_000
    expect(decideDesktopGate({ requiresDesktop: true, lock: l, now: justAfterEstimate, agent: 'taric' }).action)
      .toBe('skip')
  })

  // A missing estimate is itself worth seeing: the protocol asks for one so
  // peers can plan, and its absence means someone skipped the step.
  it('falls back to the default estimate and says it did', () => {
    const l = lock({ estimatedEndAt: null, estimateProvided: false })
    expect(lockExpiresAt(l)).toBe(NOW + DEFAULT_ESTIMATE_MS + TTL_GRACE_MS)
    const d = decideDesktopGate({ requiresDesktop: true, lock: l, now: NOW + 60_000, agent: 'taric' })
    expect(d.action).toBe('skip')
    expect(d.reason).toContain('no estimate given')
  })
})

describe('lock state IO', () => {
  it('round-trips and clears', () => {
    const p = join(dir, 'desktop-lock.json')
    writeDesktopLock(lock({ note: 'Hendi kor' }), p)
    const back = readDesktopLock(p)
    expect(back?.owner).toBe('janna')
    expect(back?.note).toBe('Hendi kor')
    clearDesktopLock(p)
    expect(readDesktopLock(p)).toBeNull()
  })

  it('treats an unreadable lock file as unlocked rather than wedging the fleet', () => {
    const p = join(dir, 'broken.json')
    writeDesktopLock(lock(), p)
    // corrupt it
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(p, '{ not json')
    expect(readDesktopLock(p)).toBeNull()
  })

  it('ignores a lock row with no owner (half-written state is not a lock)', () => {
    const p = join(dir, 'noowner.json')
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(p, JSON.stringify({ acquiredAt: NOW }))
    expect(readDesktopLock(p)).toBeNull()
  })
})

describe('skip records', () => {
  const rec = (over: Partial<DesktopSkipRecord> = {}): DesktopSkipRecord => ({
    task: 'whatsapp-figyeles', agent: 'janna', at: NOW,
    lockOwner: 'janna', lockedUntil: NOW + 3_000_000, reason: 'desktop locked by janna', ...over,
  })

  it('appends, so consecutive skips are all visible', () => {
    const p = join(dir, 'skips.json')
    recordDesktopSkip(rec({ at: NOW }), p)
    recordDesktopSkip(rec({ at: NOW + 1800_000 }), p)
    const list = JSON.parse(readFileSync(p, 'utf-8')) as DesktopSkipRecord[]
    // Two consecutive skipped rounds is exactly the case that went unnoticed
    // before this existed -- one record overwriting the other would hide it.
    expect(list).toHaveLength(2)
    expect(list[0].at).toBe(NOW)
    expect(list[1].at).toBe(NOW + 1800_000)
    expect(list[1].task).toBe('whatsapp-figyeles')
    expect(list[1].lockOwner).toBe('janna')
  })

  it('bounds the file instead of growing forever', () => {
    const p = join(dir, 'many.json')
    for (let i = 0; i < 210; i++) recordDesktopSkip(rec({ at: NOW + i }), p)
    const list = JSON.parse(readFileSync(p, 'utf-8')) as DesktopSkipRecord[]
    expect(list).toHaveLength(200)
    // the NEWEST are kept: an old trail is worth less than the current one
    expect(list[list.length - 1].at).toBe(NOW + 209)
  })

  it('never throws on an unwritable path -- losing the trail beats losing the run loop', () => {
    expect(() => recordDesktopSkip(rec(), join(dir, 'no', 'such', 'dir', 'x.json'))).not.toThrow()
    expect(existsSync(join(dir, 'no'))).toBe(false)
  })
})
