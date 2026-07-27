import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// vi.hoisted runs before vi.mock so the factory can reference the tmpdir.
const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'auto-restart-store-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))

import {
  readAutoRestartConfig,
  readAllAutoRestartConfigs,
  writeAutoRestartConfig,
} from '../web/auto-restart-store.js'
import { DEFAULT_AUTO_RESTART } from '../auto-restart.js'

const STORE_FILE = join(TMP_ROOT, 'store', 'auto-restart.json')

function cleanStore(): void {
  if (existsSync(STORE_FILE)) unlinkSync(STORE_FILE)
}

beforeEach(cleanStore)
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

describe('readAutoRestartConfig', () => {
  it('returns disabled defaults when no file exists', () => {
    const cfg = readAutoRestartConfig('jarvis')
    expect(cfg).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('returns disabled defaults for an agent with no entry', () => {
    writeAutoRestartConfig('other', { enabled: true })
    const cfg = readAutoRestartConfig('jarvis')
    expect(cfg).toEqual(DEFAULT_AUTO_RESTART)
  })

  it('returns normalized config after write', () => {
    writeAutoRestartConfig('jarvis', { enabled: true, cooldownSeconds: 60 })
    const cfg = readAutoRestartConfig('jarvis')
    expect(cfg.enabled).toBe(true)
  })
})

describe('writeAutoRestartConfig', () => {
  it('normalizes and persists a config', () => {
    const saved = writeAutoRestartConfig('rick', { enabled: true })
    expect(saved.enabled).toBe(true)
    const readBack = readAutoRestartConfig('rick')
    expect(readBack.enabled).toBe(true)
  })

  it('overwrites an existing entry without affecting others', () => {
    writeAutoRestartConfig('jarvis', { enabled: true })
    writeAutoRestartConfig('rick', { enabled: false })
    writeAutoRestartConfig('jarvis', { enabled: false })
    expect(readAutoRestartConfig('jarvis').enabled).toBe(false)
    expect(readAutoRestartConfig('rick').enabled).toBe(false)
  })

  it('handles invalid JSON in the store file gracefully', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(STORE_FILE, '{not valid json}')
    const cfg = readAutoRestartConfig('jarvis')
    expect(cfg).toEqual(DEFAULT_AUTO_RESTART)
  })
})

describe('readAllAutoRestartConfigs', () => {
  it('returns empty object when store is missing', () => {
    expect(readAllAutoRestartConfigs()).toEqual({})
  })

  it('returns all persisted agents normalized', () => {
    writeAutoRestartConfig('jarvis', { enabled: true })
    writeAutoRestartConfig('rick', { enabled: false })
    const all = readAllAutoRestartConfigs()
    expect(Object.keys(all).sort()).toEqual(['jarvis', 'rick'])
    expect(all['jarvis']!.enabled).toBe(true)
    expect(all['rick']!.enabled).toBe(false)
  })
})
