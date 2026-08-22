import { describe, it, expect, vi, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FAKE_ROOT = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-store-test-'))
  fs.mkdirSync(path.join(root, 'store'), { recursive: true })
  return root
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: FAKE_ROOT,
  STORE_DIR: FAKE_ROOT + '/store',
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn().mockImplementation((path: string, data: string) => {
    writeFileSync(path, data)
  }),
}))

import { readTerminalInputEnabled, writeTerminalInputEnabled } from '../web/terminal-input-store.js'

afterEach(() => {
  vi.clearAllMocks()
  try { rmSync(join(FAKE_ROOT, 'store', 'terminal-input.json')) } catch { /* may not exist */ }
})

describe('terminal-input-store', () => {
  it('readTerminalInputEnabled returns false when file does not exist', () => {
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('readTerminalInputEnabled returns true when file has enabled:true', () => {
    writeFileSync(join(FAKE_ROOT, 'store', 'terminal-input.json'), JSON.stringify({ enabled: true }))
    expect(readTerminalInputEnabled()).toBe(true)
  })

  it('readTerminalInputEnabled returns false when file has enabled:false', () => {
    writeFileSync(join(FAKE_ROOT, 'store', 'terminal-input.json'), JSON.stringify({ enabled: false }))
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('readTerminalInputEnabled returns false for invalid JSON (fail-closed)', () => {
    writeFileSync(join(FAKE_ROOT, 'store', 'terminal-input.json'), 'not-json')
    expect(readTerminalInputEnabled()).toBe(false)
  })

  it('writeTerminalInputEnabled sets enabled:true and returns true', () => {
    const result = writeTerminalInputEnabled(true)
    expect(result).toBe(true)
  })

  it('writeTerminalInputEnabled sets enabled:false and returns false', () => {
    const result = writeTerminalInputEnabled(false)
    expect(result).toBe(false)
  })

  it('writeTerminalInputEnabled persists state readable by readTerminalInputEnabled', () => {
    writeTerminalInputEnabled(true)
    const stored = readTerminalInputEnabled()
    expect(stored).toBe(true)
  })
})
