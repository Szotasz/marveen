import { describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'

const { scheduledWorksourceItemId, scheduledWorksourceMeta, shouldQueueScheduledToWorksource, decideTaskTimeout } = await import('../web/schedule-runner.js')

// The scheduler's worksource helpers, pinned pure: the id rule, the meta
// contract and the gate decide WHAT reaches a worksource agent's queue, so a
// drift here changes deliveries without any behavioural test noticing.

// The reader refuses any id outside this shape instead of sanitising it.
const READER_SHAPE = /^[A-Za-z0-9._-]{1,128}$/
const occ = (at: number) => ({ kind: 'occurrence' as const, at })
const manual = (at: number) => ({ kind: 'manual' as const, at })

describe('scheduledWorksourceItemId (occurrence: the UTC minute, date included)', () => {
  it('ignores seconds and ms: two timestamps in the same UTC minute give the same id', () => {
    const withSeconds = scheduledWorksourceItemId('napi-hirek', occ(Date.UTC(2026, 9, 24, 19, 0, 41)))
    const withOtherSeconds = scheduledWorksourceItemId('napi-hirek', occ(Date.UTC(2026, 9, 24, 19, 0, 2)))
    expect(withSeconds).toBe(withOtherSeconds)
    expect(withSeconds.endsWith('-20261024T1900Z')).toBe(true)
  })

  it('includes the date: the same minute on the next day is a different occurrence', () => {
    const day1 = scheduledWorksourceItemId('napi-hirek', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))
    const day2 = scheduledWorksourceItemId('napi-hirek', occ(Date.UTC(2026, 9, 25, 19, 0, 0)))
    expect(day1).not.toBe(day2)
    expect(day1.endsWith('-20261024T1900Z')).toBe(true)
    expect(day2.endsWith('-20261025T1900Z')).toBe(true)
  })

  it('a manual run has its own shape, with the timestamp, and never collides with the occurrence id', () => {
    const at = Date.UTC(2026, 9, 24, 19, 0, 41)
    const manualId = scheduledWorksourceItemId('napi-hirek', manual(at))
    expect(manualId).toMatch(new RegExp(`-manual-${Math.trunc(at)}$`))
    expect(manualId).not.toBe(scheduledWorksourceItemId('napi-hirek', occ(at)))
  })

  it('every id matches the reader shape, including a 300-character name and accented letters', () => {
    expect(scheduledWorksourceItemId('napi-hirek', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))).toMatch(READER_SHAPE)
    expect(scheduledWorksourceItemId('a'.repeat(300), occ(Date.UTC(2026, 9, 24, 19, 0, 0)))).toMatch(READER_SHAPE)
    expect(scheduledWorksourceItemId('napi hírek', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))).toMatch(READER_SHAPE)
    expect(scheduledWorksourceItemId('a'.repeat(300), manual(Date.now()))).toMatch(READER_SHAPE)
    expect(scheduledWorksourceItemId('napi hírek', manual(Date.now()))).toMatch(READER_SHAPE)
    // A name that is nothing but non-ASCII (slug becomes dashes) and a name
    // that slugs to nothing at all still yield well-formed ids.
    expect(scheduledWorksourceItemId('őúű', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))).toMatch(READER_SHAPE)
    expect(scheduledWorksourceItemId('', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))).toMatch(READER_SHAPE)
  })

  it('two names that slug to the same string still give different ids (the hash keeps them apart)', () => {
    // 'napi hírek' -> 'napi-h-rek' and 'napi-hírek' -> 'napi-h-rek': the accented
    // letter and the dash both become a dash, so the slug alone cannot tell the
    // two tasks apart. The sha256 of the full name can.
    const a = scheduledWorksourceItemId('napi hírek', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))
    const b = scheduledWorksourceItemId('napi-hírek', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))
    expect(a).not.toBe(b)
  })

  it('the stamp is UTC: 23:30 UTC on Oct 24 stamps 20261024T2330Z', () => {
    // Asserted against Date.UTC values only: setting process.env.TZ is not
    // reliable inside vitest, and the id must not depend on the local zone.
    const id = scheduledWorksourceItemId('t', occ(Date.UTC(2026, 9, 24, 23, 30, 0)))
    expect(id.endsWith('-20261024T2330Z')).toBe(true)
  })
})

describe('scheduledWorksourceMeta (exactly four string keys)', () => {
  it('names the scheduler, the item, the task and the category', () => {
    const itemId = scheduledWorksourceItemId('napi-hirek', occ(Date.UTC(2026, 9, 24, 19, 0, 0)))
    expect(scheduledWorksourceMeta('napi-hirek', itemId)).toStrictEqual({
      from: 'scheduler',
      message_id: itemId,
      task: 'napi-hirek',
      category: 'scheduled-task',
    })
  })
})

describe('shouldQueueScheduledToWorksource (local sub-agent that opted in)', () => {
  it('flag on, local, sub-agent -> true', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => true)).toBe(true)
  })

  it('flag off -> false (the typed path stays)', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => false)).toBe(false)
  })

  it('the main agent never queues, even with the flag forced on', () => {
    expect(shouldQueueScheduledToWorksource(MAIN_AGENT_ID, null, () => true)).toBe(false)
  })

  it('a remote agent (host set) never queues: the reader polls its own host', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', 'h1', () => true)).toBe(false)
  })

  it('a readFlag that throws keeps the typed path', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => { throw new Error('broken agent-config.json') })).toBe(false)
  })
})

describe('decideTaskTimeout with a worksource-queued entry', () => {
  const opts = { graceMs: 30_000, timeoutMs: 300_000, maxTrackMs: 6 * 60 * 60_000, ownerExtraMs: 600_000 }
  const entry = { injectedAt: 1_000_000, alerted: false, ownerAlerted: false, sawTurn: false }

  it('idle with no turn past the grace window is HELD, not lost: the reader re-offers the item', () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'idle', entry.injectedAt + 60_000, opts)).toBe('hold')
  })

  it('control: the same entry without viaWorksource is lost', () => {
    expect(decideTaskTimeout({ ...entry }, 'idle', entry.injectedAt + 60_000, opts)).toBe('lost')
  })

  it('maxTrackMs still ages a queued item out as abandoned', () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'idle', entry.injectedAt + opts.maxTrackMs, opts)).toBe('abandoned')
  })

  it('busy past the threshold still alerts', () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'busy', entry.injectedAt + opts.timeoutMs + 1, opts)).toBe('alert')
  })
})
