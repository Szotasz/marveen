import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeRmTmp } from './helpers/safe-rm-tmp.js'

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
})
