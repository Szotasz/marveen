import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { safeRmTmp, assertSafeTmpRoot, isStrictlyInside } from './helpers/safe-rm-tmp.js'

// The helper is what keeps a broken beforeAll (empty path variable) from
// turning a cleanup into rmSync(join('', '..')) === rmSync('..').
const made: string[] = []
function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}
// Sacrificial "outside" dir: under the cwd (the checkout), never under tmpdir, so a
// regression in the guard deletes this probe and not something real.
function mkOutside(): string {
  const d = mkdtempSync(join(process.cwd(), '.safe-rm-outside-'))
  made.push(d)
  return d
}
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('safeRmTmp', () => {
  it('removes a real mkdtemp dir with its contents', () => {
    const d = mk('safe-rm-ok-')
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'sub', 'f.txt'), 'x')
    safeRmTmp(d)
    expect(existsSync(d)).toBe(false)
  })

  it('is a no-op for a missing path inside the temp dir', () => {
    expect(() => safeRmTmp(join(tmpdir(), 'safe-rm-never-existed-xyz'))).not.toThrow()
  })

  it('rejects an empty path', () => {
    expect(() => safeRmTmp('')).toThrow(/empty/)
  })

  it("rejects '..' (what join('', '..') collapses to) and the temp dir itself", () => {
    expect(join('', '..')).toBe('..')
    expect(() => safeRmTmp('..')).toThrow(/refusing/)
    expect(() => safeRmTmp(tmpdir())).toThrow(/refusing/)
  })

  it('rejects a path outside the temp dir without touching it', () => {
    const outside = mkOutside()
    expect(() => safeRmTmp(outside)).toThrow(/refusing/)
    expect(existsSync(outside)).toBe(true)
  })

  it('rejects a symlink inside the temp dir that points outside it, leaving the target intact', () => {
    const outside = mkOutside()
    const d = mk('safe-rm-link-')
    const link = join(d, 'escape')
    symlinkSync(outside, link)
    expect(() => safeRmTmp(link)).toThrow(/refusing/)
    expect(existsSync(outside)).toBe(true)
  })

  it("rejects '.' (the cwd) and a sibling whose name only shares the temp dir prefix", () => {
    expect(() => safeRmTmp('.')).toThrow(/refusing/)
    expect(() => safeRmTmp(realpathSync(tmpdir()) + 'X/a')).toThrow(/refusing/)
  })
})

describe('safeRmTmp with a poisoned TMPDIR', () => {
  const saved = process.env.TMPDIR
  afterEach(() => {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  })
  // a missing path under the cwd: nothing can be deleted, the guard must throw first
  const victim = join(process.cwd(), '.safe-rm-never-existed-xyz')

  it('refuses TMPDIR=/', () => {
    process.env.TMPDIR = '/'
    expect(() => safeRmTmp(victim)).toThrow(/unsafe temp root/)
  })
  it('refuses TMPDIR=$HOME', () => {
    process.env.TMPDIR = homedir()
    expect(() => safeRmTmp(victim)).toThrow(/unsafe temp root/)
  })
  it('refuses TMPDIR=<parent of $HOME>', () => {
    process.env.TMPDIR = dirname(homedir())
    expect(() => safeRmTmp(victim)).toThrow(/unsafe temp root/)
  })
})

describe('assertSafeTmpRoot', () => {
  const mac = { platform: 'darwin' as const, home: '/Users/u' }
  it('accepts the macOS per-user temp dir and /private/tmp', () => {
    expect(() => assertSafeTmpRoot('/private/var/folders/ab/cd/T', mac)).not.toThrow()
    expect(() => assertSafeTmpRoot('/private/var/folders/ab/cd/T/run.X', mac)).not.toThrow()
    expect(() => assertSafeTmpRoot('/private/tmp', mac)).not.toThrow()
  })
  it('rejects /, $HOME, an ancestor of $HOME, and an empty root', () => {
    expect(() => assertSafeTmpRoot('/', mac)).toThrow(/filesystem root/)
    expect(() => assertSafeTmpRoot('/Users/u', mac)).toThrow(/equals \$HOME/)
    expect(() => assertSafeTmpRoot('/Users', mac)).toThrow(/ancestor of \$HOME/)
    expect(() => assertSafeTmpRoot('', mac)).toThrow(/empty/)
  })
  it('rejects a darwin root outside /private/var/folders and /private/tmp', () => {
    expect(() => assertSafeTmpRoot('/Users/u/scratch', mac)).toThrow(/not under/)
    expect(() => assertSafeTmpRoot('/private/var/folders', mac)).toThrow(/not under/)
    expect(() => assertSafeTmpRoot('/private/var', mac)).toThrow(/not under/)
    expect(() => assertSafeTmpRoot('/private/tmpX', mac)).toThrow(/not under/)
  })
  it('applies the same root/HOME rules with path.win32', () => {
    const win = { platform: 'win32' as const, home: 'C:\\Users\\u', pathMod: path.win32 }
    expect(() => assertSafeTmpRoot('C:\\', win)).toThrow(/filesystem root/)
    expect(() => assertSafeTmpRoot('C:\\Users\\u', win)).toThrow(/equals \$HOME/)
    expect(() => assertSafeTmpRoot('C:\\Users', win)).toThrow(/ancestor of \$HOME/)
    expect(() => assertSafeTmpRoot('C:\\Users\\u\\AppData\\Local\\Temp', win)).not.toThrow()
  })
})

describe('isStrictlyInside', () => {
  it('posix: inside, itself, parent, prefix sibling', () => {
    expect(isStrictlyInside('/t/a', '/t')).toBe(true)
    expect(isStrictlyInside('/t/..foo', '/t')).toBe(true)
    expect(isStrictlyInside('/t', '/t')).toBe(false)
    expect(isStrictlyInside('/', '/t')).toBe(false)
    expect(isStrictlyInside('/tX/a', '/t')).toBe(false)
  })
  it('path.win32: a backslash-separated escape on the same drive is rejected', () => {
    const root = 'C:\\Users\\u\\AppData\\Local\\Temp'
    expect(path.win32.relative(root, 'C:\\Users\\u\\Documents')).toBe('..\\..\\..\\Documents')
    expect(isStrictlyInside('C:\\Users\\u\\Documents', root, path.win32)).toBe(false)
    expect(isStrictlyInside('D:\\x', root, path.win32)).toBe(false)
    expect(isStrictlyInside(root, root, path.win32)).toBe(false)
    expect(isStrictlyInside(root + '\\a\\b', root, path.win32)).toBe(true)
  })
})

describe('safeRmTmp with a throwaway $HOME under the temp dir', () => {
  it('still removes a mkdtemp dir: the HOME check uses the account home, not $HOME', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'safe-rm-fakehome-'))
    const saved = process.env.HOME
    process.env.HOME = fakeHome
    try {
      const d = mkdtempSync(join(tmpdir(), 'safe-rm-victim-'))
      safeRmTmp(d)
      expect(existsSync(d)).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.HOME
      else process.env.HOME = saved
      safeRmTmp(fakeHome)
    }
  })
})
