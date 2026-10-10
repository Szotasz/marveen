// WHY THIS FILE EXISTS: Node's recursive fs.watch emits 'error' when it meets
// a subdirectory the process cannot read (another user's sandbox dir). An
// EventEmitter that emits 'error' with NO listener THROWS, which surfaced as
// an uncaughtException and took the dashboard down. The fix in
// startStoreWatcher() attaches a listener that logs each (code, path) pair
// once and keeps the watcher open. Every test that emits an error fails if
// that listener is removed, because h.watcher.emit('error', ...) then throws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ watcher: null as any, watchCalls: [] as unknown[][] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  const watch = ((...args: unknown[]) => {
    h.watchCalls.push(args)
    const w = new EventEmitter() as any
    w.close = vi.fn()
    h.watcher = w
    return w
  }) as typeof actual.watch
  return { ...actual, watch, default: { ...actual, watch } }
})

// Plain factory, no importOriginal: the real config module must not load.
// scanStore() swallows the missing directory, so nothing on disk is read.
vi.mock('../config.js', () => ({ STORE_DIR: '/nonexistent/marveen-store-watcher-test' }))
vi.mock('../db.js', () => ({ logStoreFileEvent: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { startStoreWatcher, stopStoreWatcher } from '../store-watcher.js'
import { logger } from '../logger.js'

const watchErr = (code?: string, path?: string) =>
  Object.assign(new Error('watch failed'), code === undefined ? {} : { code }, path === undefined ? {} : { path })

const skipped = () =>
  vi.mocked(logger.warn).mock.calls.filter(c => c[1] === 'store-watcher: subdirectory not watchable, skipped')

beforeEach(() => {
  vi.mocked(logger.warn).mockClear()
  h.watchCalls.length = 0
  startStoreWatcher()
})

afterEach(() => {
  stopStoreWatcher()
})

describe('store-watcher: a watch error does not take the process down', () => {
  it('starts exactly one recursive watcher on STORE_DIR', () => {
    expect(h.watchCalls.length).toBe(1)
    expect(h.watchCalls[0][0]).toBe('/nonexistent/marveen-store-watcher-test')
    expect((h.watchCalls[0][1] as { recursive?: boolean }).recursive).toBe(true)
  })

  it('listens for the error event instead of throwing it', () => {
    expect(() => h.watcher.emit('error', watchErr('EACCES', '/s/locked'))).not.toThrow()
    expect(skipped()).toHaveLength(1)
    expect(skipped()[0][0]).toEqual({ code: 'EACCES', path: '/s/locked' })
  })

  it('logs each (code, path) pair once', () => {
    h.watcher.emit('error', watchErr('EACCES', '/s/locked'))
    h.watcher.emit('error', watchErr('EACCES', '/s/locked'))
    h.watcher.emit('error', watchErr('EACCES', '/s/locked'))
    expect(skipped()).toHaveLength(1)
    h.watcher.emit('error', watchErr('EACCES', '/s/other'))
    expect(skipped()).toHaveLength(2)
    h.watcher.emit('error', watchErr('EPERM', '/s/locked'))
    expect(skipped()).toHaveLength(3)
  })

  it('does not merge pairs that only look alike', () => {
    // A joined "code:path" string would collapse both pairs below into one key.
    h.watcher.emit('error', watchErr('EACCES'))
    h.watcher.emit('error', watchErr('EACCES', ''))
    expect(skipped()).toHaveLength(2)
    h.watcher.emit('error', watchErr('EACCES', 'a:b'))
    h.watcher.emit('error', watchErr('EACCES:a', 'b'))
    expect(skipped()).toHaveLength(4)
  })

  it('handles an error with neither code nor path', () => {
    expect(() => h.watcher.emit('error', watchErr())).not.toThrow()
    h.watcher.emit('error', watchErr())
    expect(skipped()).toHaveLength(1)
    expect(skipped()[0][0]).toEqual({ code: undefined, path: undefined })
  })

  it('keeps the watcher open across errors', () => {
    h.watcher.emit('error', watchErr('EACCES', '/s/locked'))
    expect(h.watcher.close).not.toHaveBeenCalled()
    stopStoreWatcher()
    expect(h.watcher.close).toHaveBeenCalledTimes(1)
  })

  it('resets the dedup set on each start', () => {
    // The set lives inside startStoreWatcher(), so a restart must re-report
    // a pair the previous watcher already logged.
    h.watcher.emit('error', watchErr('EACCES', '/s/locked'))
    expect(skipped()).toHaveLength(1)
    stopStoreWatcher()
    startStoreWatcher()
    h.watcher.emit('error', watchErr('EACCES', '/s/locked'))
    expect(skipped()).toHaveLength(2)
  })
})
