import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardTick } from '../costops/quota-guard.js'
import { PROJECT_ROOT } from '../config.js'

/**
 * The gap this closes: checkContextCeilings() was written, tested and merged
 * with no production caller. Every test passed, the feature was "done", and it
 * would never have run once -- the same done-but-never-executes silence the
 * whole CostOps slice exists to surface, committed by the thing surfacing it.
 *
 * The logic tests could not catch it, because a function's tests say nothing
 * about whether anything calls it. These assert the wiring instead.
 */

describe('the periodic tick runs every watch', () => {
  it('invokes both the quota guard and the context ceiling', async () => {
    const quota = vi.fn(async () => undefined)
    const ceiling = vi.fn(() => undefined)
    await guardTick({ quota, ceiling })
    expect(quota, 'the quota guard was not called').toHaveBeenCalledTimes(1)
    expect(ceiling, 'the context ceiling was not called -- the original bug').toHaveBeenCalledTimes(1)
  })

  it('still runs the ceiling check when the quota guard throws', async () => {
    // A guard that takes its sibling down is worse than either alone.
    const ceiling = vi.fn(() => undefined)
    await guardTick({ quota: async () => { throw new Error('usage endpoint gone') }, ceiling })
    expect(ceiling).toHaveBeenCalledTimes(1)
  })

  it('still runs the quota guard when the ceiling check throws', async () => {
    const quota = vi.fn(async () => undefined)
    await guardTick({ quota, ceiling: () => { throw new Error('db locked') } })
    expect(quota).toHaveBeenCalledTimes(1)
  })

  it('never throws into its scheduler', async () => {
    await expect(guardTick({
      quota: async () => { throw new Error('a') },
      ceiling: () => { throw new Error('b') },
    })).resolves.toBeUndefined()
  })
})

describe('the tick is actually started at boot', () => {
  // Asserting the call chain end to end: guardTick could invoke every watch
  // correctly and still never run if nothing starts the timer.
  const webSource = readFileSync(join(PROJECT_ROOT, 'src', 'web.ts'), 'utf-8')

  it('web.ts starts the guard task', () => {
    expect(webSource).toContain('startQuotaGuardTask()')
  })

  it('and imports it from the module that owns the tick', () => {
    expect(webSource).toContain("from './costops/quota-guard.js'")
  })
})
