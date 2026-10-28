import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rm, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsNs from 'node:fs'
import { rm as rmP } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

// Duplicated on purpose: importing the setup file here would install the guard
// from the test's own import and hide a setup file that is not wired in.
const MARKER = Symbol.for('test-suite.rm-guard.installed')
const REFUSED = /rm-guard: refusing/

const checkout = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const nonexistentOutside = (): string => resolve(checkout, '..', `rm-guard-nonexistent-${randomBytes(6).toString('hex')}`)

type Opts = { recursive?: boolean; force?: boolean }
const OPTION_SETS: Array<[string, Opts]> = [
  ['recursive+force', { recursive: true, force: true }],
  ['force alone', { force: true }],
]
const SYNC_CALLERS: Array<[string, (p: string, o: Opts) => unknown]> = [
  ['named rmSync', (p, o) => rmSync(p, o)],
  ['named rm (callback)', (p, o) => rm(p, o, () => {})],
  ['named rmdirSync', (p, o) => rmdirSync(p, o as never)],
  ['default fs.rmSync', (p, o) => fs.rmSync(p, o)],
  ['default fs.rm (callback)', (p, o) => fs.rm(p, o, () => {})],
  ['default fs.rmdirSync', (p, o) => fs.rmdirSync(p, o as never)],
  ['namespace fsNs.rmSync', (p, o) => fsNs.rmSync(p, o)],
  ['namespace fsNs.rm (callback)', (p, o) => fsNs.rm(p, o, () => {})],
]

describe('rm-guard (global setup file)', () => {
  // The root-deleting cases below must never run without the guard.
  beforeAll(() => {
    if ((fs as unknown as Record<symbol, unknown>)[MARKER] !== true) {
      throw new Error('rm-guard is not installed: the setup file is missing from vitest setupFiles')
    }
  })

  it('is installed', () => {
    expect((fs as unknown as Record<symbol, unknown>)[MARKER]).toBe(true)
  })

  describe.each(OPTION_SETS)('outside path, %s', (_label, opts) => {
    it.each(SYNC_CALLERS)('%s throws', (_name, call) => {
      expect(() => call(nonexistentOutside(), opts)).toThrow(REFUSED)
    })

    it('node:fs/promises rm rejects', async () => {
      await expect(rmP(nonexistentOutside(), opts)).rejects.toThrow(REFUSED)
    })

    it('fs.promises.rm rejects', async () => {
      await expect(fs.promises.rm(nonexistentOutside(), opts)).rejects.toThrow(REFUSED)
    })
  })

  it('refuses a relative path that resolves outside', () => {
    const rel = relative(process.cwd(), nonexistentOutside())
    expect(() => rmSync(rel, { recursive: true, force: true })).toThrow(REFUSED)
  })

  it('refuses a ".." walk out of a temp dir', () => {
    const made = mkdtempSync(join(tmpdir(), 'rm-guard-'))
    try {
      const escaped = `${made}/../../rm-guard-nonexistent-${randomBytes(6).toString('hex')}`
      expect(() => rmSync(escaped, { recursive: true, force: true })).toThrow(REFUSED)
    } finally {
      rmSync(made, { recursive: true, force: true })
    }
  })

  describe('roots themselves', () => {
    const roots: Array<[string, string]> = [['temp dir', realpathSync(tmpdir())], ['checkout root', realpathSync(checkout)]]
    if (existsSync('/tmp')) roots.push(['/tmp', realpathSync('/tmp')])
    it.each(roots)('%s throws', (_name, root) => {
      expect(() => rmSync(root, { recursive: true, force: true })).toThrow(REFUSED)
      expect(() => rmSync(root, { force: true })).toThrow(REFUSED)
    })
    it('the checkout .git throws', () => {
      expect(() => rmSync(join(checkout, '.git'), { recursive: true, force: true })).toThrow(REFUSED)
    })
  })

  it('an empty path throws', () => {
    expect(() => rmSync('', { recursive: true, force: true })).toThrow(REFUSED)
    expect(() => rmSync('', { force: true })).toThrow(REFUSED)
  })

  it('leaves calls without recursive or force alone', () => {
    // No guard check: the original error (ENOENT) surfaces, not a refusal.
    expect(() => rmSync(nonexistentOutside())).toThrow(/ENOENT/)
    expect(() => rmSync(nonexistentOutside(), {})).toThrow(/ENOENT/)
  })

  it('removes a real directory under the temp dir', () => {
    const made = mkdtempSync(join(tmpdir(), 'rm-guard-'))
    mkdirSync(join(made, 'a', 'b'), { recursive: true })
    writeFileSync(join(made, 'a', 'b', 'f.txt'), 'x')
    rmSync(made, { recursive: true, force: true })
    expect(existsSync(made)).toBe(false)
  })

  it('does not throw for a non-existing path inside the checkout with force', () => {
    const p = join(checkout, `rm-guard-nonexistent-${randomBytes(6).toString('hex')}`, 'deeper')
    expect(() => rmSync(p, { force: true })).not.toThrow()
    expect(() => rmSync(p, { recursive: true, force: true })).not.toThrow()
  })

  it('removes a symlink to another temp dir, not its target', () => {
    const holder = mkdtempSync(join(tmpdir(), 'rm-guard-'))
    const target = mkdtempSync(join(tmpdir(), 'rm-guard-'))
    try {
      writeFileSync(join(target, 'keep.txt'), 'x')
      const link = join(holder, 'link')
      symlinkSync(target, link)
      rmSync(link, { recursive: true, force: true })
      expect(() => lstatSync(link)).toThrow(/ENOENT/)
      expect(existsSync(join(target, 'keep.txt'))).toBe(true)
    } finally {
      rmSync(holder, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})
