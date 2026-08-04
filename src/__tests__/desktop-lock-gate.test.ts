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
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
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

// The broadcast marker must stay BARE: `[DESKTOP-LOCK]` / `[DESKTOP-FREE]` with any
// qualifier AFTER the closing bracket. Peers scan for these with a start-anchored
// `content LIKE '[DESKTOP-LOCK...'`, and a qualifier moved INSIDE the brackets silently
// defeats the bracket-closing variant of that pattern.
//
// Measured on 2026-08-04: a lock announced as `[DESKTOP-LOCK -- on behalf of the owner]`
// returned ZERO hits from a peer's `LIKE '[DESKTOP-LOCK]%'` check. The strictest lock of
// the day was the one the detector could not see, and the peer nearly started a browser
// round on top of the human owner's live session.
//
// A static source assert, mirroring the other structural-invariant tests in this suite:
// the shape has to hold for every message the route can emit, and enumerating them
// through the HTTP handler would test less for more setup.
describe('broadcast marker shape', () => {
  const src = readFileSync(
    join(__dirname, '..', 'web', 'routes', 'desktop-lock.ts'), 'utf-8',
  )

  it('never puts a qualifier inside the marker brackets', () => {
    // Scan CODE only: the comment above the constant quotes the broken shape on
    // purpose (that is what makes the comment useful), and a scan that cannot
    // tell code from prose would either fail forever or force the explanation out.
    const code = src
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n')
    const bad = [...code.matchAll(/\[DESKTOP-(LOCK|FREE)(?!\])/g)]
      .map(m => code.slice(m.index, (m.index ?? 0) + 60))
    expect(bad).toEqual([])
  })

  it('still emits both markers', () => {
    expect(src).toContain('[DESKTOP-LOCK]')
    expect(src).toContain('[DESKTOP-FREE]')
  })
})

// ORDERING INVARIANT: in every branch the STATE write happens before the broadcast,
// and a failing broadcast never rolls the state back.
//
// This is a deliberate asymmetry, not an oversight: the gate reads the STATE, the
// message is only how humans and agents hear about it. If a message-queue error
// could undo the lock, then the ERROR would open the gate -- the worst direction.
// The consequence worth knowing when reading a half-applied deploy: "state set,
// nobody told" is possible (safe: the gate holds, quietly), while "told, no state"
// is NOT reachable through this route at all.
//
// Locked by a test rather than by line numbers in a runbook: the numbers drift the
// first time someone edits the file, and a drifted reference reads as fact.
describe('state-before-broadcast ordering', () => {
  const src = readFileSync(
    join(__dirname, '..', 'web', 'routes', 'desktop-lock.ts'), 'utf-8',
  )
  const code = src
    .split('\n')
    .filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n')

  // Each entry: the state call that must come first, then the notification after it.
  const branches: Array<[string, RegExp]> = [
    ['writeDesktopLock(lock)', /broadcast\(owner,/],
    ['clearDesktopLock()', /broadcast\(lock\.owner,/],
  ]

  for (const [stateCall, notifyRx] of branches) {
    it(`${stateCall} precedes its broadcast`, () => {
      const stateIdx = code.indexOf(stateCall)
      expect(stateIdx).toBeGreaterThan(-1)
      const notifyIdx = code.slice(stateIdx).search(notifyRx)
      expect(notifyIdx).toBeGreaterThan(-1)
    })
  }

  it('never rolls the state back when a broadcast fails', () => {
    // the per-target catch logs and continues; it must not call the state writers
    const helper = code.slice(code.indexOf('function broadcast('), code.indexOf('function hu('))
    expect(helper).not.toMatch(/clearDesktopLock|writeDesktopLock/)
  })
})
