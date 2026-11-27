/**
 * SCHEDDONEB1127: a session task that went idle after a turn is recorded as 'done' only when its prompt's
 * delivery is verified; otherwise the run closes as 'done-unverified'.
 *
 * Before: the sweep closed every such run as 'done', and the delivery verdict (intact / spliced / tail-lost /
 * paste-wrapped ...) went only into the delivery column. A damaged prompt that got a short reply read as a
 * success in the duration statistics and the status summary. Measured on a live install: runs with a
 * 'paste-wrapped' or 'spliced' delivery closed as done in 5-10 s.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { closedRunOutcome } from '../web/schedule-runner.js'
import { summarizeTaskRuns } from '../web/system-status.js'
import { initDatabase, appendTaskRun, markTaskRunCompleted, getTaskRunMedianDurationMs } from '../db.js'
import type { DeliveryVerdict } from '../web/delivery-integrity.js'

const LOCAL = { remote: false, worksourceAcked: false }

describe('closedRunOutcome: done only with a verified delivery', () => {
  it('intact and intact-queued stay done', () => {
    expect(closedRunOutcome('done', 'intact', LOCAL)).toBe('done')
    expect(closedRunOutcome('done', 'intact-queued', LOCAL)).toBe('done')
  })

  it('a damaged or unverified delivery with a turn is done-unverified, never done', () => {
    const damaged: (DeliveryVerdict | undefined)[] = ['spliced', 'tail-lost', 'head-lost', 'split', 'paste-wrapped', 'not-arrived', 'unverifiable', undefined]
    for (const v of damaged) expect(closedRunOutcome('done', v, LOCAL), String(v)).toBe('done-unverified')
  })

  it('a remote or worksource-acknowledged run has no verdict to check and stays done', () => {
    expect(closedRunOutcome('done', undefined, { remote: true, worksourceAcked: false })).toBe('done')
    expect(closedRunOutcome('done', undefined, { remote: false, worksourceAcked: true })).toBe('done')
  })

  it('abandoned passes through unchanged, whatever the verdict', () => {
    expect(closedRunOutcome('abandoned', 'intact', LOCAL)).toBe('abandoned')
    expect(closedRunOutcome('abandoned', 'spliced', LOCAL)).toBe('abandoned')
  })
})

describe('the sweep records the outcome closedRunOutcome gives (source level: the sweep needs a live install)', () => {
  const src = readFileSync(join(__dirname, '..', 'web', 'schedule-runner.ts'), 'utf-8')
  it('the done/abandoned branch closes the row with closedRunOutcome, not the bare decision', () => {
    expect(src).toContain("markTaskRunCompleted(entry.runId, closedRunOutcome(decision, entry.deliveryVerdict, { remote: entry.host != null, worksourceAcked: worksourceStage === 'done' }), now)")
    expect(src).not.toContain('markTaskRunCompleted(entry.runId, decision, now)')
  })
})

describe('done-unverified is not a success for the statistics', () => {
  beforeAll(() => { initDatabase(':memory:') })

  it('the median duration counts only done rows', () => {
    // Five done runs of 60 s and five done-unverified runs of 5 s: the median must stay 60 s.
    for (let i = 0; i < 5; i++) {
      const ok = appendTaskRun('median-probe', 'nora')
      markTaskRunCompleted(ok, 'done', Date.now() + 60_000)
      const bad = appendTaskRun('median-probe', 'nora')
      markTaskRunCompleted(bad, 'done-unverified', Date.now() + 5_000)
    }
    const median = getTaskRunMedianDurationMs('median-probe')
    expect(median).not.toBeNull()
    expect(median!).toBeGreaterThanOrEqual(59_000)
  })

  it('the status summary does not count done-unverified as "lefutott"', () => {
    const s = summarizeTaskRuns([
      { status: 'fired', outcome: 'done', completed_at: 2 },
      { status: 'fired', outcome: 'done-unverified', completed_at: 2 },
      { status: 'fired', outcome: 'done-unverified', completed_at: 2 },
    ])
    expect(s).toContain('lefutott 1')
    expect(s).toContain('done-unverified 2')
  })
})
