import { describe, it, expect, beforeEach, vi } from 'vitest'
import { pickLsofPath } from '../lsof.js'

// LSOFPATH805. These tests replay the SERVICE's environment, not the
// developer's: the launchd PATH that omits /usr/sbin. The pure resolver is
// injected with env + an isExecutable predicate so it is deterministic and
// platform-independent -- reverting the absolute-first behaviour turns them red.

// The measured production PATH (Marveen, ps eww pid 48719): no /usr/sbin.
const LAUNCHD_PATH = '/opt/homebrew/bin:/Users/marvin/.bun/bin:/usr/local/bin:/usr/bin:/bin'

describe('pickLsofPath -- resolves lsof under a PATH that omits /usr/sbin', () => {
  it('finds /usr/sbin/lsof even though it is NOT on the launchd PATH', () => {
    // Only /usr/sbin/lsof exists (the macOS reality). A PATH-only lookup would
    // miss it -- the absolute-candidates-first list is what saves it.
    const isExec = (p: string) => p === '/usr/sbin/lsof'
    expect(pickLsofPath({ PATH: LAUNCHD_PATH }, isExec)).toBe('/usr/sbin/lsof')
  })

  it('REGRESSION: a PATH-only resolver (the pre-fix behaviour) returns null here', () => {
    // Simulate what the code did before: resolve lsof from PATH alone. Under
    // the launchd PATH with lsof only in /usr/sbin, that finds nothing. This is
    // the exact production blindness; it documents why absolute-first matters.
    const isExec = (p: string) => p === '/usr/sbin/lsof'
    const pathOnly = (env: NodeJS.ProcessEnv): string | null => {
      for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
        if (isExec(`${dir}/lsof`)) return `${dir}/lsof`
      }
      return null
    }
    expect(pathOnly({ PATH: LAUNCHD_PATH })).toBeNull() // the bug
    expect(pickLsofPath({ PATH: LAUNCHD_PATH }, isExec)).toBe('/usr/sbin/lsof') // the fix
  })

  it('prefers an absolute location over a PATH hit (deterministic order)', () => {
    const isExec = () => true // everything executable
    expect(pickLsofPath({ PATH: '/opt/homebrew/bin' }, isExec)).toBe('/usr/sbin/lsof')
  })

  it('falls through to a PATH entry when no absolute candidate exists (Linux/homebrew)', () => {
    const isExec = (p: string) => p === '/opt/homebrew/bin/lsof'
    expect(pickLsofPath({ PATH: '/opt/homebrew/bin:/usr/bin' }, isExec)).toBe('/opt/homebrew/bin/lsof')
  })

  it('returns null when lsof exists nowhere', () => {
    expect(pickLsofPath({ PATH: LAUNCHD_PATH }, () => false)).toBeNull()
  })
})

// The silent-swallow removal: when lsof is genuinely unresolvable, runLsof must
// WARN (once) and return null -- never a silent empty that reads as "no match".
// node:fs is mocked so accessSync always fails, making resolution null on ANY
// platform (deterministic), independent of whether this box has lsof.
describe('runLsof -- a missing lsof is LOUD, not silent', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return { ...actual, accessSync: () => { throw new Error('ENOENT (mocked: no lsof anywhere)') } }
    })
  })

  it('warns exactly once across repeated calls and returns null', async () => {
    const { logger } = await import('../logger.js')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never)
    const { runLsof, resolveLsofPath, __resetLsofCache } = await import('../lsof.js')
    __resetLsofCache()

    expect(resolveLsofPath()).toBeNull() // mocked accessSync -> nothing executable
    expect(runLsof(['-ti', ':3420'], 1000)).toBeNull()
    expect(runLsof(['-ti', ':3420'], 1000)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1) // once per process, not per call

    warn.mockRestore()
    vi.doUnmock('node:fs')
  })
})
