import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// store-watcher uses STORE_DIR from config.js. We mock config.js so the
// watcher operates in a temp dir and never touches the real store.
const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'store-watcher-test-'))
  const dir = join(root, 'store')
  mkdirSync(dir, { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: dir }
})

vi.mock('../config.js', () => ({ PROJECT_ROOT: TMP_ROOT, STORE_DIR }))

// Also stub out the DB call so the watcher can run without a real DB.
vi.mock('../db.js', async (orig) => {
  const actual = await orig<typeof import('../db.js')>()
  return { ...actual, logStoreFileEvent: vi.fn() }
})

import {
  setStoreWriteActor,
  clearStoreWriteActor,
  startStoreWatcher,
  stopStoreWatcher,
} from '../store-watcher.js'

afterEach(() => stopStoreWatcher())

describe('setStoreWriteActor / clearStoreWriteActor', () => {
  it('can be called without throwing', () => {
    expect(() => setStoreWriteActor('dashboard')).not.toThrow()
    expect(() => clearStoreWriteActor()).not.toThrow()
  })

  it('can be called multiple times', () => {
    setStoreWriteActor('dashboard')
    setStoreWriteActor('another')
    clearStoreWriteActor()
    clearStoreWriteActor()
  })
})

describe('startStoreWatcher / stopStoreWatcher', () => {
  it('starts without throwing', () => {
    expect(() => startStoreWatcher()).not.toThrow()
  })

  it('is idempotent -- calling start twice does not throw', () => {
    startStoreWatcher()
    expect(() => startStoreWatcher()).not.toThrow()
  })

  it('stop is idempotent -- calling stop when not started does not throw', () => {
    expect(() => stopStoreWatcher()).not.toThrow()
  })

  it('stop after start closes cleanly', () => {
    startStoreWatcher()
    expect(() => stopStoreWatcher()).not.toThrow()
  })
})
