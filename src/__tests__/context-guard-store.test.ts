import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { unlinkSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'context-guard-store-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))

import {
  readContextGuardConfig,
  readAllContextGuardConfigs,
  writeContextGuardConfig,
} from '../web/context-guard-store.js'
import { DEFAULT_CONTEXT_GUARD } from '../context-guard.js'

const STORE_FILE = join(TMP_ROOT, 'store', 'context-guard.json')

function cleanStore(): void {
  if (existsSync(STORE_FILE)) unlinkSync(STORE_FILE)
}

beforeEach(cleanStore)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('readContextGuardConfig', () => {
  it('returns disabled defaults when no file exists', () => {
    expect(readContextGuardConfig('agent-a')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('returns disabled defaults for an agent with no entry', () => {
    writeContextGuardConfig('other', { enabled: true })
    expect(readContextGuardConfig('agent-a')).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('returns the stored value after a write', () => {
    writeContextGuardConfig('agent-a', { enabled: true })
    expect(readContextGuardConfig('agent-a').enabled).toBe(true)
  })
})

describe('writeContextGuardConfig', () => {
  it('normalizes and persists a config', () => {
    const saved = writeContextGuardConfig('agent-d', { enabled: true })
    expect(saved.enabled).toBe(true)
    expect(readContextGuardConfig('agent-d').enabled).toBe(true)
  })

  it('overwrites an existing entry without affecting others', () => {
    writeContextGuardConfig('agent-a', { enabled: true })
    writeContextGuardConfig('agent-d', { enabled: false })
    writeContextGuardConfig('agent-a', { enabled: false })
    expect(readContextGuardConfig('agent-a').enabled).toBe(false)
    expect(readContextGuardConfig('agent-d').enabled).toBe(false)
  })

  it('survives corrupted store file', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(STORE_FILE, 'INVALID')
    expect(readContextGuardConfig('agent-a')).toEqual(DEFAULT_CONTEXT_GUARD)
  })
})

describe('readAllContextGuardConfigs', () => {
  it('returns empty object when store is missing', () => {
    expect(readAllContextGuardConfigs()).toEqual({})
  })

  it('returns all persisted agents', () => {
    writeContextGuardConfig('agent-a', { enabled: true })
    writeContextGuardConfig('agent-d', { enabled: false })
    const all = readAllContextGuardConfigs()
    expect(Object.keys(all).sort()).toEqual(['agent-a', 'agent-d'])
  })
})
