import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAIN_AGENT_ID } from '../config.js'
import { worksourceItemStageAt, worksourcePendingHeadAt } from '../web/worksource-queue.js'
import { agentDir } from '../web/agent-config.js'

const { scheduledWorksourceItemId, scheduledWorksourceMeta, shouldQueueScheduledToWorksource, decideTaskTimeout, isWorksourceItemStuckInPending } = await import('../web/schedule-runner.js')

// readdir order is the filesystem's: for the pending/ head test it is forced to reverse-lexical, so the head is
// found by the sort in worksourcePendingHeadAt and not by the order the files happened to come back in.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    readdirSync: ((p: Parameters<typeof real.readdirSync>[0], ...rest: unknown[]) => {
      const names = (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest)
      return String(p).includes('worksource-head-unsorted') && Array.isArray(names)
        ? [...(names as string[])].sort().reverse()
        : names
    }) as typeof real.readdirSync,
  }
})

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
  it('flag on, local, sub-agent, no gate -> true', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => true, () => false)).toBe(true)
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

describe('shouldQueueScheduledToWorksource: the sender-role gate keeps the typed path', () => {
  // The queue delivers inside a <channel> envelope, which the gate's hook
  // treats as a non-owner sender; a typed prompt is treated as the owner.
  // Queueing into a gated agent would silently disarm its scheduled tasks.
  it('flag on + gate on -> false: the prompt is typed, not queued', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => true, () => true)).toBe(false)
  })

  it('flag on + gate off -> true', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => true, () => false)).toBe(true)
  })

  it('flag on + gate read throws -> false (typed, like a throwing readFlag)', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => true, () => { throw new Error('broken agent-config.json') })).toBe(false)
  })

  it('flag off + gate on -> false: the flag is never bypassed by the gate', () => {
    expect(shouldQueueScheduledToWorksource('cortex-router', null, () => false, () => true)).toBe(false)
  })
})

describe('worksourceItemStageAt (which queue directory holds the item)', () => {
  const root = mkdtempSync(join(tmpdir(), 'worksource-stage-'))
  const put = (stage: string, id: string): void => {
    mkdirSync(join(root, stage), { recursive: true })
    writeFileSync(join(root, stage, `${id}.json`), '{}')
  }

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reports the directory the item is in: pending, active, done', () => {
    put('pending', 'in-pending')
    put('active', 'in-active')
    put('done', 'in-done')
    expect(worksourceItemStageAt(root, 'in-pending')).toBe('pending')
    expect(worksourceItemStageAt(root, 'in-active')).toBe('active')
    expect(worksourceItemStageAt(root, 'in-done')).toBe('done')
  })

  it('an unknown id is in none of them: null', () => {
    expect(worksourceItemStageAt(root, 'no-such-item')).toBeNull()
  })

  it('an id present in more than one directory reports the first in the order pending, active, done', () => {
    put('done', 'two-dirs-pd')
    put('pending', 'two-dirs-pd')
    expect(worksourceItemStageAt(root, 'two-dirs-pd')).toBe('pending')

    put('done', 'two-dirs-ad')
    put('active', 'two-dirs-ad')
    expect(worksourceItemStageAt(root, 'two-dirs-ad')).toBe('active')

    put('pending', 'three-dirs')
    put('active', 'three-dirs')
    put('done', 'three-dirs')
    expect(worksourceItemStageAt(root, 'three-dirs')).toBe('pending')
  })

  it('a root that does not exist is a probe, not an error: null', () => {
    expect(worksourceItemStageAt(join(root, 'no-such-root'), 'any')).toBeNull()
  })
})

describe('worksourcePendingHeadAt (the item the reader hands over next)', () => {
  const root = mkdtempSync(join(tmpdir(), 'worksource-head-unsorted-'))
  const put = (stage: string, id: string): void => {
    mkdirSync(join(root, stage), { recursive: true })
    writeFileSync(join(root, stage, `${id}.json`), '{}')
  }

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('an empty pending/ has no next item: null', () => {
    mkdirSync(join(root, 'pending'), { recursive: true })
    expect(worksourcePendingHeadAt(root)).toBeNull()
  })

  it('a missing pending/ is a probe, not an error: null', () => {
    expect(worksourcePendingHeadAt(join(root, 'no-such-root'))).toBeNull()
  })

  it("returns the lexically smallest id and ignores names that do not end in '.json'", () => {
    put('pending', 'b-item')
    put('pending', 'a-item')
    // Reader-shaped noise in the same directory: a half-written tmp file and a
    // dotfile. ('.hidden.json' WOULD count -- the reader's filter, and ours,
    // is endsWith('.json'), so it is deliberately not used here.)
    writeFileSync(join(root, 'pending', 'b.json.tmp'), '{}')
    writeFileSync(join(root, 'pending', '.hidden'), '{}')
    expect(worksourcePendingHeadAt(root)).toBe('a-item')
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

describe('decideTaskTimeout: a queued item still in pending/ past the grace window climbs the alert ladder', () => {
  // The queue's reader owns the hand-off, so the item is never 'lost' -- but
  // pending/ means the reader never took it, and that must be TOLD to someone
  // instead of holding silently until maxTrackMs ages it out. The gate is the
  // LENGTH of the pending run (worksourcePendingSince), not the stage alone:
  // a working reader re-offers an unacknowledged item, so a single 'pending'
  // sample is the healthy queue's normal face.
  const opts = { graceMs: 30_000, timeoutMs: 300_000, maxTrackMs: 6 * 60 * 60_000, ownerExtraMs: 600_000 }
  const entry = { injectedAt: 1_000_000, alerted: false, ownerAlerted: false, sawTurn: false }
  const at = (msPast: number) => entry.injectedAt + msPast
  // The ladder's precondition: the sweep stamped worksourcePendingSince at the
  // injection itself, so every `at(...)` below is a pending run >= graceMs.
  const stuck = { ...entry, viaWorksource: true, worksourcePendingSince: entry.injectedAt }

  it("stage 'pending', not yet alerted -> alert", () => {
    expect(decideTaskTimeout({ ...stuck }, 'idle', at(60_000), opts, 'pending')).toBe('alert')
  })

  it("stage 'pending' but first seen less than graceMs ago -> hold (a one-poll requeue by a working reader)", () => {
    // The sweep at at(45_000) is the FIRST to see the item in pending/ (the
    // reader re-offered it), so 30 s short of the grace window it is still the
    // ordinary face of a working queue -- no alert yet.
    expect(decideTaskTimeout({ ...entry, viaWorksource: true, worksourcePendingSince: at(45_000) }, 'idle', at(45_000 + opts.graceMs - 1), opts, 'pending')).toBe('hold')
  })

  it("stage 'pending' with no worksourcePendingSince -> hold", () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'idle', at(60_000), opts, 'pending')).toBe('hold')
  })

  it("stage 'pending', alerted, still inside the owner window -> hold", () => {
    expect(decideTaskTimeout({ ...stuck, alerted: true }, 'idle', at(opts.graceMs + opts.ownerExtraMs - 1), opts, 'pending')).toBe('hold')
  })

  it('escalation is measured from the pending run, not from the injection', () => {
    // A LATE pending run: the item was handed over, requeued, and only then
    // did the reader die -- 80 minutes after the injection. Measuring the
    // owner window from the injection would escalate on the very sweep after
    // the main-agent notice; from the run, 31 s in is still a plain hold.
    const now = at(80 * 60_000)
    const lateRun = { ...entry, viaWorksource: true, alerted: true, ownerAlerted: false }
    expect(decideTaskTimeout({ ...lateRun, worksourcePendingSince: now - 31_000 }, 'idle', now, opts, 'pending')).toBe('hold')
    expect(decideTaskTimeout({ ...lateRun, worksourcePendingSince: now - (opts.graceMs + opts.ownerExtraMs) }, 'idle', now, opts, 'pending')).toBe('escalate')
  })

  it("stage 'pending', alerted, past the owner window, not ownerAlerted -> escalate", () => {
    expect(decideTaskTimeout({ ...stuck, alerted: true }, 'idle', at(opts.graceMs + opts.ownerExtraMs), opts, 'pending')).toBe('escalate')
  })

  it("stage 'pending', alerted and ownerAlerted -> hold (both notices already out)", () => {
    expect(decideTaskTimeout({ ...stuck, alerted: true, ownerAlerted: true }, 'idle', at(opts.graceMs + opts.ownerExtraMs), opts, 'pending')).toBe('hold')
  })

  it("sawTurn true, idle, stage 'pending' for >= graceMs -> alert, not done (an unrelated turn is no evidence)", () => {
    // sawTurn comes from ANY transcript write (or a busy pane): the agent can
    // be chatting with a human while its queue reader is dead, so a turn must
    // not close an entry whose item is still sitting in pending/.
    expect(decideTaskTimeout({ ...stuck, sawTurn: true }, 'idle', at(60_000), opts, 'pending')).toBe('alert')
  })

  it("sawTurn true, idle, stage 'active' -> done (unchanged)", () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true, sawTurn: true }, 'idle', at(60_000), opts, 'active')).toBe('done')
  })

  it("stage 'active' -> hold: the reader handed it over, the agent owns the work", () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'idle', at(60_000), opts, 'active')).toBe('hold')
  })

  it("stage 'done' -> hold: the agent acknowledged the item", () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'idle', at(60_000), opts, 'done')).toBe('hold')
  })

  it('stage null (no signal, e.g. unreadable queue) -> hold', () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'idle', at(60_000), opts, null)).toBe('hold')
  })

  it('stage omitted -> hold (four-argument callers keep their behaviour)', () => {
    expect(decideTaskTimeout({ ...entry, viaWorksource: true }, 'idle', at(60_000), opts)).toBe('hold')
  })

  it("past maxTrackMs with stage 'pending' -> abandoned (the age-out rule still comes first)", () => {
    expect(decideTaskTimeout({ ...stuck }, 'idle', at(opts.maxTrackMs), opts, 'pending')).toBe('abandoned')
  })

  it("control: the same 'pending' stage on an entry WITHOUT viaWorksource keeps today's 'lost'", () => {
    expect(decideTaskTimeout({ ...entry }, 'idle', at(60_000), opts, 'pending')).toBe('lost')
  })
})

describe('isWorksourceItemStuckInPending (the one predicate behind the ladder and the alert wording)', () => {
  const since = 1_000_000
  const graceMs = 30_000
  const queued = { viaWorksource: true, worksourcePendingSince: since }

  it('true at exactly graceMs: a pending run that has spanned the whole window', () => {
    expect(isWorksourceItemStuckInPending(queued, 'pending', since + graceMs, graceMs)).toBe(true)
  })

  it('false just below graceMs: one poll is not a dead reader', () => {
    expect(isWorksourceItemStuckInPending(queued, 'pending', since + graceMs - 1, graceMs)).toBe(false)
  })

  it("false for 'active': the reader handed the item over", () => {
    expect(isWorksourceItemStuckInPending(queued, 'active', since + graceMs, graceMs)).toBe(false)
  })

  it('false without viaWorksource: the typed path has no queue item to judge', () => {
    expect(isWorksourceItemStuckInPending({ worksourcePendingSince: since }, 'pending', since + graceMs, graceMs)).toBe(false)
  })

  it('false with no pendingSince: the sweep has not seen a pending run yet', () => {
    expect(isWorksourceItemStuckInPending({ viaWorksource: true }, 'pending', since + graceMs, graceMs)).toBe(false)
  })
})

describe('shouldQueueScheduledToWorksource: the default gate reads the agent config', () => {
  // A name no live fleet member can collide with; its directory exists only during this describe.
  const NAME = 'zz-ws-gate-probe'
  const dir = agentDir(NAME)
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })
  const writeConfig = (cfg: unknown): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(cfg))
  }
  it('an enabled sender-role gate keeps the typed path', () => {
    writeConfig({ senderRoleGate: { riskyTools: ['Bash'] } })
    expect(shouldQueueScheduledToWorksource(NAME, null, () => true)).toBe(false)
  })
  it('a present but disabled gate (no risky tools) does not', () => {
    writeConfig({ senderRoleGate: { riskyTools: [] } })
    expect(shouldQueueScheduledToWorksource(NAME, null, () => true)).toBe(true)
  })
  it('no gate in the config does not', () => {
    writeConfig({})
    expect(shouldQueueScheduledToWorksource(NAME, null, () => true)).toBe(true)
  })
})
