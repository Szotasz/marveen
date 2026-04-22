import { describe, it, expect } from 'vitest'
import { checkUpdatePreflight, type GitRunner } from '../update-preflight.js'

// Helper: build a GitRunner from plain strings. Covers the common
// "return this exact branch / status" fixtures without dragging in a
// real git invocation.
function makeGit(branch: string, porcelain = ''): GitRunner {
  return {
    currentBranch: () => branch,
    porcelainStatus: () => porcelain,
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

describe('checkUpdatePreflight --feature branch', () => {
  it('rejects any branch name other than main', () => {
    const result = checkUpdatePreflight(makeGit('v3-05-ui-trustfrom-picker'))
    expect(result.ok).toBe(false)
    if (result.ok || result.reason !== 'not-on-main') {
      throw new Error('expected not-on-main result')
    }
    expect(result.branch).toBe('v3-05-ui-trustfrom-picker')
    expect(result.message).toContain("'v3-05-ui-trustfrom-picker'")
    expect(result.message).toMatch(/git checkout main/)
  })

  it('rejects "master" (a common misconfiguration)', () => {
    const result = checkUpdatePreflight(makeGit('master'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-on-main')
  })

  it('prioritises not-on-main over dirty-tree when both apply', () => {
    // Switching to main first invalidates the dirty-tree check anyway
    // (the modifications may or may not carry across branches), so the
    // useful error message for the user is "switch branches", not
    // "commit your changes on this branch".
    const result = checkUpdatePreflight(makeGit('feature-x', ' M src/web.ts\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-on-main')
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

describe('checkUpdatePreflight --result shape', () => {
  it('never emits a branch field on the ok path', () => {
    const result = checkUpdatePreflight(makeGit('main'))
    // TypeScript alone does not enforce this at runtime, so assert it.
    expect(Object.hasOwn(result, 'branch')).toBe(false)
  })

  it('only emits a branch field on the not-on-main path', () => {
    const detached = checkUpdatePreflight(makeGit(''))
    expect(Object.hasOwn(detached, 'branch')).toBe(false)

    const dirty = checkUpdatePreflight(makeGit('main', ' M x'))
    expect(Object.hasOwn(dirty, 'branch')).toBe(false)

    const feature = checkUpdatePreflight(makeGit('feature-x'))
    expect(Object.hasOwn(feature, 'branch')).toBe(true)
  })
})
