import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ENFORCED sandbox. The previous version of this file wrote fixtures into --
// and unlink'd -- the LIVE repo-root .env (snapshot/restore around each test),
// which in a production checkout recreated the real secrets file with default
// 0644 permissions (2026-07-27 incident). env.ts resolves its own PROJECT_ROOT
// (it cannot import config.js -- circular), so the redirect is the
// CLAUDECLAW_ENV_DIR hook read at module import; set it BEFORE the dynamic
// import below. vitest isolates module registries per test file, so the hook
// cannot leak into other suites.
const SANDBOX = mkdtempSync(join(tmpdir(), 'env-test-'))
const testEnvPath = join(SANDBOX, '.env')

beforeAll(() => {
  process.env.CLAUDECLAW_ENV_DIR = SANDBOX
})

afterAll(() => {
  delete process.env.CLAUDECLAW_ENV_DIR
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('readEnvFile', () => {
  it('ures objektumot ad vissza ha nincs .env', async () => {
    try { unlinkSync(testEnvPath) } catch { /* absent */ }
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result).toEqual({})
  })

  it('kulcs-ertek parokat parszol', async () => {
    writeFileSync(testEnvPath, 'FOO=bar\nBAZ=qux\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['FOO']).toBe('bar')
    expect(result['BAZ']).toBe('qux')
  })

  it('idezojeleket kezel', async () => {
    writeFileSync(testEnvPath, 'KEY="value with spaces"\nKEY2=\'single\'\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('value with spaces')
    expect(result['KEY2']).toBe('single')
  })

  it('kommenteket atugorja', async () => {
    writeFileSync(testEnvPath, '# komment\nKEY=val\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('val')
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('szurt kulcsokat ad vissza ha megadva', async () => {
    writeFileSync(testEnvPath, 'A=1\nB=2\nC=3\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile(['A', 'C'])
    expect(result['A']).toBe('1')
    expect(result['C']).toBe('3')
    expect(result['B']).toBeUndefined()
  })
})
