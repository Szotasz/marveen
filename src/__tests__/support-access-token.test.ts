import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  isSupportToken,
  readSupportToken,
  removeSupportToken,
  writeSupportToken,
  SupportTokenError,
  SUPPORT_TOKEN_FILE,
} from '../support-access-token.js'

// TEST ONLY values: the right shape, issued by nobody.
const TOKEN = 'mst_' + 'TESTONLY'.repeat(5) + '_-0'
const OTHER = 'mst_' + 'testonly'.repeat(5) + '-_9'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof SupportTokenError) return err.code
    throw err
  }
  return 'no error'
}

describe('support token on disk', () => {
  let root: string
  let dir: string
  let file: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'support-token-'))
    dir = join(root, 'store')
    mkdirSync(dir, { mode: 0o700 })
    file = join(dir, SUPPORT_TOKEN_FILE)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('isSupportToken', () => {
    it('accepts the token shape and nothing else', () => {
      expect(isSupportToken(TOKEN)).toBe(true)
      for (const bad of [
        '',
        'mst_',
        'mst_short',
        'mst_' + 'A'.repeat(42),
        'mst_' + 'A'.repeat(44),
        'mrv_' + 'A'.repeat(43),
        'MST_' + 'A'.repeat(43),
        ' ' + TOKEN,
        TOKEN + '\n',
        TOKEN + ' x',
        'mst_' + 'A'.repeat(42) + '+',
        'mst_' + 'A'.repeat(42) + '/',
        'mst_' + 'A'.repeat(42) + '"',
        'mst_' + 'A'.repeat(42) + '=',
        'x' + TOKEN,
        undefined,
        42,
      ]) {
        expect(isSupportToken(bad)).toBe(false)
      }
    })
  })

  describe('writeSupportToken', () => {
    it('writes one line, mode 0600, and reads back', () => {
      writeSupportToken(dir, TOKEN)
      expect(readFileSync(file, 'utf8')).toBe(TOKEN + '\n')
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readSupportToken(dir)).toEqual({ kind: 'ok', token: TOKEN })
    })

    it('is 0600 even when the process umask is zero', () => {
      const saved = process.umask(0)
      try {
        writeSupportToken(dir, TOKEN)
      } finally {
        process.umask(saved)
      }
      expect(statSync(file).mode & 0o777).toBe(0o600)
    })

    it('is 0600 even when the process umask would strip every bit', () => {
      const saved = process.umask(0o777)
      try {
        writeSupportToken(dir, TOKEN)
      } finally {
        process.umask(saved)
      }
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readSupportToken(dir)).toEqual({ kind: 'ok', token: TOKEN })
    })

    it('replaces an earlier token and leaves no temporary file behind', () => {
      writeSupportToken(dir, TOKEN)
      writeSupportToken(dir, OTHER)
      expect(readSupportToken(dir)).toEqual({ kind: 'ok', token: OTHER })
      expect(readdirSync(dir)).toEqual([SUPPORT_TOKEN_FILE])
    })

    it('replaces a token file that others could read with a 0600 one', () => {
      writeFileSync(file, OTHER + '\n', { mode: 0o644 })
      chmodSync(file, 0o644)
      writeSupportToken(dir, TOKEN)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readSupportToken(dir)).toEqual({ kind: 'ok', token: TOKEN })
    })

    it.each([
      ['a licence key', 'mrv_' + 'A'.repeat(43)],
      ['a value with a newline', TOKEN + '\nsecond'],
      ['an empty value', ''],
    ])('refuses %s and writes nothing', (_label, value) => {
      expect(codeOf(() => writeSupportToken(dir, value))).toBe('token_shape')
      expect(readdirSync(dir)).toEqual([])
    })

    it('NEVER puts the refused value into the error', () => {
      const secret = 'mst_' + 'SECRETVALUE'.repeat(4)
      try {
        writeSupportToken(dir, secret)
        throw new Error('expected a refusal')
      } catch (err) {
        expect(err).toBeInstanceOf(SupportTokenError)
        expect(String((err as Error).message)).not.toContain('SECRETVALUE')
        expect(JSON.stringify(err)).not.toContain('SECRETVALUE')
        expect(String((err as Error).stack)).not.toContain('SECRETVALUE')
      }
    })

    it('refuses a directory that is missing, is a symbolic link, or is writable by others', () => {
      expect(codeOf(() => writeSupportToken(join(root, 'nope'), TOKEN))).toBe('token_dir_unsafe')
      expect(existsSync(join(root, 'nope'))).toBe(false)
      symlinkSync(dir, join(root, 'link'))
      expect(codeOf(() => writeSupportToken(join(root, 'link'), TOKEN))).toBe('token_dir_unsafe')
      for (const mode of [0o770, 0o707, 0o777]) {
        chmodSync(dir, mode)
        expect(codeOf(() => writeSupportToken(dir, TOKEN))).toBe('token_dir_unsafe')
      }
      chmodSync(dir, 0o700)
      expect(readdirSync(dir)).toEqual([])
    })

    it('accepts a directory others can only read', () => {
      chmodSync(dir, 0o755)
      writeSupportToken(dir, TOKEN)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    })

    it('refuses to write through a symbolic link, and leaves its target alone', () => {
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, 'untouched\n')
      symlinkSync(elsewhere, file)
      expect(codeOf(() => writeSupportToken(dir, TOKEN))).toBe('token_path_unsafe')
      expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n')
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
    })

    it('refuses when a directory stands at the token path', () => {
      mkdirSync(file)
      expect(codeOf(() => writeSupportToken(dir, TOKEN))).toBe('token_path_unsafe')
    })
  })

  describe('readSupportToken', () => {
    it('says missing when there is no file', () => {
      expect(readSupportToken(dir)).toEqual({ kind: 'missing' })
      expect(readSupportToken(join(root, 'nope'))).toEqual({ kind: 'missing' })
    })

    it('reads a token with or without the final newline', () => {
      writeFileSync(file, TOKEN, { mode: 0o600 })
      expect(readSupportToken(dir)).toEqual({ kind: 'ok', token: TOKEN })
    })

    it.each([0o640, 0o604, 0o644, 0o660, 0o601])('does NOT use a file with mode %o', (mode) => {
      writeFileSync(file, TOKEN + '\n')
      chmodSync(file, mode)
      expect(readSupportToken(dir)).toEqual({ kind: 'invalid', reason: 'mode' })
    })

    it.each([
      ['a second line', TOKEN + '\nx\n'],
      ['two final newlines', TOKEN + '\n\n'],
      ['a leading space', ' ' + TOKEN + '\n'],
      ['a carriage return', TOKEN + '\r\n'],
      ['another shape', 'mrv_' + 'A'.repeat(43) + '\n'],
      ['an empty file', ''],
    ])('does NOT use a file with %s', (_label, content) => {
      writeFileSync(file, content, { mode: 0o600 })
      expect(readSupportToken(dir)).toEqual({ kind: 'invalid', reason: 'shape' })
    })

    // S2 of Dani's review: a size cap, checked on the opened descriptor.
    it.each([
      ['a second token on a second line', TOKEN + '\n' + OTHER + '\n'],
      ['an oversized file', TOKEN + '\n' + 'x'.repeat(600)],
      ['one byte over the cap', 'x'.repeat(65)],
    ])('does NOT read a file with %s', (_label, content) => {
      writeFileSync(file, content, { mode: 0o600 })
      expect(readSupportToken(dir)).toEqual({ kind: 'invalid', reason: 'size' })
    })

    it('reads a file at the cap as far as the shape check', () => {
      writeFileSync(file, 'x'.repeat(64), { mode: 0o600 })
      expect(readSupportToken(dir)).toEqual({ kind: 'invalid', reason: 'shape' })
    })

    it('does NOT read through a directory that is a link or that others can write', () => {
      writeFileSync(file, TOKEN + '\n', { mode: 0o600 })
      symlinkSync(dir, join(root, 'link'))
      expect(readSupportToken(join(root, 'link'))).toEqual({ kind: 'invalid', reason: 'dir' })
      for (const mode of [0o770, 0o707, 0o777]) {
        chmodSync(dir, mode)
        expect(readSupportToken(dir)).toEqual({ kind: 'invalid', reason: 'dir' })
      }
      chmodSync(dir, 0o755)
      expect(readSupportToken(dir)).toEqual({ kind: 'ok', token: TOKEN })
    })

    it('does not wait on a named pipe at the path', () => {
      const made = spawnSync('mkfifo', ['-m', '600', file])
      expect(made.status).toBe(0)
      expect(readSupportToken(dir)).toEqual({ kind: 'invalid', reason: 'not_a_file' })
    })

    it('does NOT follow a symbolic link, even to a well-formed token', () => {
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, TOKEN + '\n', { mode: 0o600 })
      symlinkSync(elsewhere, file)
      expect(readSupportToken(dir)).toEqual({ kind: 'invalid', reason: 'not_a_file' })
    })
  })

  describe('removeSupportToken', () => {
    it('removes the file and is idempotent', () => {
      writeSupportToken(dir, TOKEN)
      expect(removeSupportToken(dir)).toEqual({ removed: true })
      expect(existsSync(file)).toBe(false)
      expect(removeSupportToken(dir)).toEqual({ removed: false })
      expect(removeSupportToken(join(root, 'nope'))).toEqual({ removed: false })
    })

    it('removes a symbolic link at the path, never its target', () => {
      const elsewhere = join(root, 'elsewhere')
      writeFileSync(elsewhere, 'untouched\n')
      symlinkSync(elsewhere, file)
      expect(removeSupportToken(dir)).toEqual({ removed: true })
      expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n')
      expect(readSupportToken(dir)).toEqual({ kind: 'missing' })
    })

    it('removes a token file of the wrong mode or shape too', () => {
      writeFileSync(file, 'garbage', { mode: 0o644 })
      expect(removeSupportToken(dir)).toEqual({ removed: true })
      expect(existsSync(file)).toBe(false)
    })

    it('does not report success while something is still at the path', () => {
      mkdirSync(file)
      expect(codeOf(() => removeSupportToken(dir))).toBe('token_remains')
    })
  })
})
