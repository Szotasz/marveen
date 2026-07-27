import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const testEnvPath = join(PROJECT_ROOT, '.env')

let hadExistingEnv = false
let existingContent = ''

beforeEach(() => {
  if (existsSync(testEnvPath)) {
    hadExistingEnv = true
    existingContent = require('fs').readFileSync(testEnvPath, 'utf-8')
  }
})

afterEach(() => {
  if (hadExistingEnv) {
    writeFileSync(testEnvPath, existingContent)
  } else {
    try { unlinkSync(testEnvPath) } catch {}
  }
})

describe('readEnvFile', () => {
  it('ures objektumot ad vissza ha nincs .env', async () => {
    try { unlinkSync(testEnvPath) } catch {}
    // Friss import
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

describe('updateEnvFile', () => {
  it('no-op when all values are empty', async () => {
    writeFileSync(testEnvPath, 'FOO=bar\n')
    const { updateEnvFile, readEnvFile } = await import('../env.js')
    updateEnvFile({ FOO: '' })
    expect(readEnvFile()['FOO']).toBe('bar')
  })

  it('creates .env if missing and appends new key', async () => {
    try { unlinkSync(testEnvPath) } catch {}
    const { updateEnvFile, readEnvFile } = await import('../env.js')
    updateEnvFile({ NEW_KEY: 'newval' })
    expect(readEnvFile()['NEW_KEY']).toBe('newval')
  })

  it('updates existing key preserving other lines', async () => {
    writeFileSync(testEnvPath, 'FOO=old\nBAR=keep\n')
    const { updateEnvFile, readEnvFile } = await import('../env.js')
    updateEnvFile({ FOO: 'new' })
    const result = readEnvFile()
    expect(result['FOO']).toBe('new')
    expect(result['BAR']).toBe('keep')
  })

  it('appends key not yet in file', async () => {
    writeFileSync(testEnvPath, 'A=1\n')
    const { updateEnvFile, readEnvFile } = await import('../env.js')
    updateEnvFile({ B: '2' })
    const result = readEnvFile()
    expect(result['A']).toBe('1')
    expect(result['B']).toBe('2')
  })

  it('preserves comments and blank lines', async () => {
    writeFileSync(testEnvPath, '# comment\nFOO=bar\n\nBAZ=qux\n')
    const { updateEnvFile, readEnvFile } = await import('../env.js')
    updateEnvFile({ FOO: 'updated' })
    const result = readEnvFile()
    expect(result['FOO']).toBe('updated')
    expect(result['BAZ']).toBe('qux')
  })
})
