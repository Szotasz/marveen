import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression cover for the 04:00 auto-update boot crash: a transient PATH gap
// makes `which claude` fail, and a module-level `resolveFromPath('claude')`
// then threw at import time, taking the whole dashboard (and the scheduler that
// lives in it) down. tryResolveFromPath must fall back to known install dirs,
// and makeLazyBinResolver must not resolve (or throw) until first use.

const mockExecSync = vi.fn()
const mockExistsSync = vi.fn()

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => mockExistsSync(p) }
})

import { tryResolveFromPath, resolveFromPath, makeLazyBinResolver } from '../platform.js'

beforeEach(() => {
  mockExecSync.mockReset()
  mockExistsSync.mockReset()
  mockExistsSync.mockReturnValue(false)
})

describe('tryResolveFromPath', () => {
  it('returns the which-resolved path when PATH resolves the binary', () => {
    mockExecSync.mockReturnValue('/opt/homebrew/bin/claude\n')
    expect(tryResolveFromPath('claude')).toBe('/opt/homebrew/bin/claude')
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('falls back to a known install dir when which fails (transient PATH gap)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which: no claude in PATH') })
    mockExistsSync.mockImplementation((p: string) => p === '/opt/homebrew/bin/claude')
    expect(tryResolveFromPath('claude')).toBe('/opt/homebrew/bin/claude')
  })

  it('probes /usr/local/bin when /opt/homebrew/bin has no binary', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockImplementation((p: string) => p === '/usr/local/bin/tmux')
    expect(tryResolveFromPath('tmux')).toBe('/usr/local/bin/tmux')
  })

  it('returns null (does NOT throw) when the binary is absent everywhere', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    expect(tryResolveFromPath('claude')).toBeNull()
  })

  it('rejects an invalid binary name before touching the shell', () => {
    expect(() => tryResolveFromPath('claude; rm -rf /')).toThrow(/Invalid binary name/)
    expect(mockExecSync).not.toHaveBeenCalled()
  })
})

describe('resolveFromPath', () => {
  it('throws only when the binary is truly unresolvable', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    expect(() => resolveFromPath('claude')).toThrow(/Required binary not found/)
  })
})

describe('makeLazyBinResolver', () => {
  it('does not resolve at construction time (safe during a boot-time PATH gap)', () => {
    makeLazyBinResolver('claude')
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('resolves on first call and memoises the result', () => {
    mockExecSync.mockReturnValue('/opt/homebrew/bin/tmux\n')
    const tmuxBin = makeLazyBinResolver('tmux')
    expect(tmuxBin()).toBe('/opt/homebrew/bin/tmux')
    expect(tmuxBin()).toBe('/opt/homebrew/bin/tmux')
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('surfaces the not-found error on first use, not at import', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    const claudeBin = makeLazyBinResolver('claude')
    expect(() => claudeBin()).toThrow(/Required binary not found/)
  })
})
