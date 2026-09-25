import { describe, it, expect } from 'vitest'
import {
  checkUpdatePreflight,
  checkNoConcurrentUpdate,
  classifyLockWriteError,
  type GitRunner,
  type PidfileRunner,
} from '../update-preflight.js'

// Helper: build a GitRunner from plain strings. Covers the common
// "return this exact branch / status" fixtures without dragging in a
// real git invocation.
function makeGit(
  branch: string,
  porcelain = '',
  ahead = 0,
  behind = 0,
  onOrigin: 'yes' | 'no' | 'unknown' = 'yes',
): GitRunner {
  return {
    currentBranch: () => branch,
    porcelainStatus: () => porcelain,
    aheadCount: () => ahead,
    behindCount: () => behind,
    originHasBranch: () => onOrigin,
  }
}

describe('checkUpdatePreflight --happy path', () => {
  it('returns ok when on main with a clean tree', () => {
    const result = checkUpdatePreflight(makeGit('main', ''))
    expect(result.ok).toBe(true)
  })

  it('ignores whitespace-only branch output', () => {
    const result = checkUpdatePreflight(makeGit('  main  ', '   '))
    expect(result.ok).toBe(true)
  })
})

describe('checkUpdatePreflight --local commits (diverged history)', () => {
  it('rejects when the checkout is both ahead of and behind the upstream', () => {
    const result = checkUpdatePreflight(makeGit('main', '', 2, 5))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('local-commits')
    if (result.reason !== 'local-commits') return
    expect(result.ahead).toBe(2)
    expect(result.message).toMatch(/fast-forward/)
  })

  it('passes a clean tree with zero ahead', () => {
    expect(checkUpdatePreflight(makeGit('main', '', 0)).ok).toBe(true)
  })

  // The rule update.sh actually applies since 2026-08-30: ahead with nothing
  // behind is an install that also develops locally, the pull is a no-op, and
  // the update proceeds. Blocking it here locked the button on a tree that
  // was in fact current.
  it('passes when ahead but not behind, matching update.sh', () => {
    expect(checkUpdatePreflight(makeGit('main', '', 53, 0)).ok).toBe(true)
  })

  it('dirty-tree takes precedence over divergence (stash is offered first)', () => {
    const result = checkUpdatePreflight(makeGit('main', ' M src/x.ts', 3, 3))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty-tree')
  })
})

describe('checkUpdatePreflight --branch missing on origin', () => {
  // update.sh exits 2 on a local-only branch. Without this gate the dashboard
  // answered {ok:true}, spawned a run that could never start, and showed the
  // reload countdown anyway.
  it('rejects a branch origin does not have', () => {
    const result = checkUpdatePreflight(makeGit('fix/local-only', '', 0, 0, 'no'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('branch-not-on-origin')
    if (result.reason !== 'branch-not-on-origin') return
    expect(result.branch).toBe('fix/local-only')
    expect(result.message).toMatch(/origin/)
  })

  it('does NOT block when the probe could not answer (offline, auth failure)', () => {
    expect(checkUpdatePreflight(makeGit('main', '', 0, 0, 'unknown')).ok).toBe(true)
  })

  // update.sh checks the branch BEFORE the dirty tree, so both entry points
  // must name the same first reason; stashing would not have helped here.
  it('reports the missing branch before the dirty tree, as update.sh does', () => {
    const result = checkUpdatePreflight(makeGit('fix/local-only', ' M src/x.ts', 0, 0, 'no'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('branch-not-on-origin')
  })

  it('still reports detached HEAD first', () => {
    const result = checkUpdatePreflight(makeGit('HEAD', '', 0, 0, 'no'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('detached-head')
  })
})

describe('checkUpdatePreflight --detached HEAD', () => {
  it('rejects an empty branch name', () => {
    const result = checkUpdatePreflight(makeGit(''))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('detached-head')
    expect(result.message).toMatch(/detached-HEAD/)
  })

  it('rejects the literal "HEAD" that git prints for detached checkouts', () => {
    const result = checkUpdatePreflight(makeGit('HEAD'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('detached-head')
  })

  it('prioritises detached-HEAD over dirty-tree when both apply', () => {
    // If we are detached we do not want a "commit your changes" message,
    // because the right next step is checkout main first.
    const result = checkUpdatePreflight(makeGit('HEAD', ' M src/web.ts\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('detached-head')
  })
})

describe('checkUpdatePreflight --branch agnostic', () => {
  it('accepts a non-main release branch on a clean tree', () => {
    // The update is branch-agnostic: update.sh pulls origin/<this-branch>.
    // An install that tracks "develop" must be allowed to self-update.
    const result = checkUpdatePreflight(makeGit('develop', ''))
    expect(result.ok).toBe(true)
  })

  it('accepts an arbitrary feature branch on a clean tree', () => {
    const result = checkUpdatePreflight(makeGit('v3-05-ui-trustfrom-picker', ''))
    expect(result.ok).toBe(true)
  })

  it('accepts "master" on a clean tree', () => {
    const result = checkUpdatePreflight(makeGit('master', ''))
    expect(result.ok).toBe(true)
  })

  it('still blocks a dirty tree regardless of branch name', () => {
    // The branch is fine, but uncommitted changes would break the
    // fast-forward pull, so dirty-tree is the reported reason.
    const result = checkUpdatePreflight(makeGit('develop', ' M src/web.ts\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty-tree')
  })
})

describe('checkUpdatePreflight --dirty working tree', () => {
  it('rejects unstaged modifications', () => {
    const result = checkUpdatePreflight(makeGit('main', ' M src/web.ts\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty-tree')
    expect(result.message).toMatch(/git stash/)
  })

  it('rejects staged modifications', () => {
    const result = checkUpdatePreflight(makeGit('main', 'M  src/web.ts\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty-tree')
  })

  it('rejects a mix of staged and unstaged', () => {
    const result = checkUpdatePreflight(
      makeGit('main', 'M  src/web.ts\n M src/db.ts\n'),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('dirty-tree')
  })

  it('accepts on-main with only trailing whitespace in porcelain output', () => {
    // `git status --porcelain` returns a trailing newline even when
    // clean on some platforms. Trim-then-compare keeps that from being
    // read as dirty.
    const result = checkUpdatePreflight(makeGit('main', '\n'))
    expect(result.ok).toBe(true)
  })
})

describe('checkUpdatePreflight -- result shape', () => {
  it('never emits a branch field on any path', () => {
    // No result carries a branch field anymore; the update is
    // branch-agnostic, so the branch name is never part of a rejection.
    const ok = checkUpdatePreflight(makeGit('main'))
    expect(Object.hasOwn(ok, 'branch')).toBe(false)

    const detached = checkUpdatePreflight(makeGit(''))
    expect(Object.hasOwn(detached, 'branch')).toBe(false)

    const dirty = checkUpdatePreflight(makeGit('main', ' M x'))
    expect(Object.hasOwn(dirty, 'branch')).toBe(false)

    const feature = checkUpdatePreflight(makeGit('feature-x'))
    expect(Object.hasOwn(feature, 'branch')).toBe(false)
  })
})

function makePidfile(
  raw: string | null,
  alivePids: number[] = [],
  nowMs = 1_000_000_000_000,
): PidfileRunner {
  return {
    readPidfile: () => raw,
    isProcessAlive: (pid) => alivePids.includes(pid),
    now: () => nowMs,
  }
}

describe('checkNoConcurrentUpdate -- no pidfile', () => {
  it('allows when no pidfile exists', () => {
    const result = checkNoConcurrentUpdate(makePidfile(null))
    expect(result.ok).toBe(true)
  })

  it('allows when pidfile is empty', () => {
    const result = checkNoConcurrentUpdate(makePidfile(''))
    expect(result.ok).toBe(true)
  })

  it('allows when pidfile is whitespace-only', () => {
    const result = checkNoConcurrentUpdate(makePidfile('   \n\n'))
    expect(result.ok).toBe(true)
  })
})

describe('checkNoConcurrentUpdate -- stale or corrupt pidfile', () => {
  it('treats a non-numeric pidfile as stale', () => {
    const result = checkNoConcurrentUpdate(makePidfile('not-a-number'))
    expect(result.ok).toBe(true)
  })

  it('treats a negative-sign pidfile as stale (regex rejects leading minus)', () => {
    const result = checkNoConcurrentUpdate(makePidfile('-1'))
    expect(result.ok).toBe(true)
  })

  it('treats pid 0 as stale (reserved)', () => {
    const result = checkNoConcurrentUpdate(makePidfile('0', [0]))
    expect(result.ok).toBe(true)
  })

  it('treats pid 1 as stale even if it would probe alive (init)', () => {
    // init is always alive on Unix; if we ever trusted a stale
    // pidfile that happened to contain "1", the Update button would
    // be locked forever.
    const result = checkNoConcurrentUpdate(makePidfile('1', [1]))
    expect(result.ok).toBe(true)
  })

  it('treats a dead pid as stale', () => {
    const result = checkNoConcurrentUpdate(makePidfile('12345', []))
    expect(result.ok).toBe(true)
  })
})

describe('checkNoConcurrentUpdate -- live pidfile', () => {
  it('refuses when a live pid is in the file', () => {
    const result = checkNoConcurrentUpdate(makePidfile('7777', [7777]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('already-running')
    expect(result.pid).toBe(7777)
    expect(result.message).toContain('7777')
  })

  it('parses a leading-integer pid even with trailing noise', () => {
    // A pidfile written by `echo $$` on some shells may include extra
    // trailing bytes. Accept the leading integer and ignore the rest.
    const result = checkNoConcurrentUpdate(makePidfile('7777 started at 12:00\n', [7777]))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.pid).toBe(7777)
  })

  it('trims leading whitespace before parsing', () => {
    const result = checkNoConcurrentUpdate(makePidfile('\n  7777\n', [7777]))
    expect(result.ok).toBe(false)
  })
})

describe('checkNoConcurrentUpdate -- age-based staleness', () => {
  const HOUR_MS = 60 * 60 * 1000

  it('accepts a fresh dashboard-written pidfile (pid + recent epoch)', () => {
    const now = 2_000_000_000_000
    const start = now - 1000 // 1 second old
    const result = checkNoConcurrentUpdate(
      makePidfile(`7777\n${start}\n`, [7777], now),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.pid).toBe(7777)
  })

  it('treats a >1-hour-old pidfile as stale even if the pid is alive', () => {
    // Defends against SIGKILL + PID recycling: if we ever believed a
    // live-looking pid in a pidfile that was written an hour ago, the
    // button would stay locked by an unrelated process that happens to
    // have the same PID now.
    const now = 2_000_000_000_000
    const start = now - (HOUR_MS + 1) // 1 ms past the cutoff
    const result = checkNoConcurrentUpdate(
      makePidfile(`7777\n${start}\n`, [7777], now),
    )
    expect(result.ok).toBe(true)
  })

  it('accepts the boundary: exactly 1 hour old is still alive', () => {
    const now = 2_000_000_000_000
    const start = now - HOUR_MS // exactly the cutoff
    const result = checkNoConcurrentUpdate(
      makePidfile(`7777\n${start}\n`, [7777], now),
    )
    expect(result.ok).toBe(false)
  })

  it('falls back to alive-only check when epoch line is missing (legacy format)', () => {
    const result = checkNoConcurrentUpdate(
      makePidfile('7777', [7777], 2_000_000_000_000),
    )
    expect(result.ok).toBe(false)
  })

  it('ignores a non-numeric epoch line and falls back to alive-only', () => {
    const result = checkNoConcurrentUpdate(
      makePidfile('7777\nnot-an-epoch', [7777], 2_000_000_000_000),
    )
    expect(result.ok).toBe(false)
  })

  it('ignores a zero or negative epoch and falls back to alive-only', () => {
    // Parsed but rejected by the `> 0` guard, so the caller does not
    // time-travel the pidfile with a zero-epoch placeholder.
    const result = checkNoConcurrentUpdate(
      makePidfile('7777\n0\n', [7777], 2_000_000_000_000),
    )
    expect(result.ok).toBe(false)
  })
})

describe('classifyLockWriteError', () => {
  it('classifies EEXIST as a concurrency race', () => {
    expect(classifyLockWriteError('EEXIST')).toBe('race')
  })

  it('classifies EACCES as a non-race write failure', () => {
    expect(classifyLockWriteError('EACCES')).toBe('other')
  })

  it('classifies EROFS as a non-race write failure', () => {
    expect(classifyLockWriteError('EROFS')).toBe('other')
  })

  it('classifies ENOSPC as a non-race write failure', () => {
    expect(classifyLockWriteError('ENOSPC')).toBe('other')
  })

  it('classifies undefined code as non-race (plain Error / string throw)', () => {
    // retryErr may not be an ErrnoException -- a plain Error, a string,
    // or null reaches the site. The helper should fall through to the
    // 500 branch instead of misreading no-code as EEXIST.
    expect(classifyLockWriteError(undefined)).toBe('other')
  })

  it('classifies empty string code as non-race', () => {
    expect(classifyLockWriteError('')).toBe('other')
  })
})
