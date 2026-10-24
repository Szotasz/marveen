import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Same sandbox hook as env.test.ts: env.ts must never resolve the live repo .env.
const SANDBOX = mkdtempSync(join(tmpdir(), 'env-write-fresh-'))
process.env.CLAUDECLAW_ENV_DIR = SANDBOX
const { writeEnvFileFresh } = await import('../env.js')

afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

const mode = (p: string) => statSync(p).mode & 0o777

describe('writeEnvFileFresh', () => {
  it('tightens an existing 0644 .env to 0600 (writeFileSync mode alone would not)', () => {
    const p = join(SANDBOX, 'existing.env')
    writeFileSync(p, 'OLD=1\n')
    chmodSync(p, 0o644)
    writeEnvFileFresh(p, 'NEW=2\n')
    expect(readFileSync(p, 'utf-8')).toBe('NEW=2\n')
    expect(mode(p)).toBe(0o600)
  })

  // The file is REPLACED (temp file + rename), not rewritten in place: a new
  // inode, so the old loose file object never holds the new secrets.
  it('replaces an existing file instead of writing through it (new inode, read-only original)', () => {
    const p = join(SANDBOX, 'readonly.env')
    writeFileSync(p, 'OLD=1\n')
    chmodSync(p, 0o444)
    const before = statSync(p).ino
    writeEnvFileFresh(p, 'NEW=3\n')
    expect(readFileSync(p, 'utf-8')).toBe('NEW=3\n')
    expect(mode(p)).toBe(0o600)
    expect(statSync(p).ino).not.toBe(before)
  })

  it('creates a new .env at 0600', () => {
    const p = join(SANDBOX, 'new.env')
    writeEnvFileFresh(p, 'A=1\n')
    expect(mode(p)).toBe(0o600)
  })

  // scripts/setup.ts runs its interactive main() on import, so the call site is
  // pinned by source: the full .env write must go through the helper.
  it('scripts/setup.ts writes the full .env through it', () => {
    const src = readFileSync(new URL('../../scripts/setup.ts', import.meta.url), 'utf-8')
    expect(src).toContain('writeEnvFileFresh(envPath, envContent)')
    expect(src).not.toContain('writeFileSync(envPath, envContent')
  })
})
