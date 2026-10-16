// WHY THIS FILE EXISTS: on Linux, Node's recursive fs.watch emits a 'rename'
// event for every directory it walks while it sets itself up. scanStore()
// only puts FILES into knownFiles, so each of those directory events used to
// pass the "not known yet" check and be logged as a newly created file -- on
// every boot, for every directory under store/ (one measured start wrote
// 26 527 audit rows, the same directory 22 times across restarts, and the
// synchronous INSERTs held the event loop for ~20 s before the port answered).
// The directory test fails if the isDirectory() skip is removed; the file test
// is the positive control that the watcher still records a real new file.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR || '/tmp'}/marveen-store-watcher-dir-test-${process.pid}`,
  cb: null as null | ((eventType: string, filename: string | null) => void),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  const watch = ((_dir: unknown, _opts: unknown, cb: (e: string, f: string | null) => void) => {
    h.cb = cb
    const w = new EventEmitter() as any
    w.close = () => {}
    return w
  }) as unknown as typeof actual.watch
  return { ...actual, watch, default: { ...actual, watch } }
})

vi.mock('../config.js', () => ({ STORE_DIR: h.dir }))
vi.mock('../db.js', () => ({ logStoreFileEvent: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { startStoreWatcher, stopStoreWatcher } from '../store-watcher.js'
import { logStoreFileEvent } from '../db.js'

beforeAll(() => {
  // A leftover tree from an interrupted run (same pid reused) would put the
  // "new" files into knownFiles at start and break the positive control.
  rmSync(h.dir, { recursive: true, force: true })
  mkdirSync(`${h.dir}/existing-dir/nested`, { recursive: true })
  writeFileSync(`${h.dir}/existing-dir/known.txt`, 'x')
})

afterAll(() => {
  rmSync(h.dir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.mocked(logStoreFileEvent).mockClear()
  startStoreWatcher()
})

afterEach(() => {
  stopStoreWatcher()
})

describe('store-watcher: directories are not logged as created files', () => {
  it('ignores the rename events the recursive watcher emits for existing directories', () => {
    h.cb!('rename', 'existing-dir')
    h.cb!('rename', 'existing-dir/nested')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })

  it('ignores a directory created after start', () => {
    mkdirSync(`${h.dir}/new-dir`, { recursive: true })
    h.cb!('rename', 'new-dir')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })

  it('still logs a file created after start (positive control)', () => {
    writeFileSync(`${h.dir}/existing-dir/agent-made.txt`, 'hello')
    h.cb!('rename', 'existing-dir/agent-made.txt')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][0]).toBe('existing-dir/agent-made.txt')
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][3]).toBe(5)
  })

  it('still logs a new symlink that points to a directory', () => {
    symlinkSync(`${h.dir}/existing-dir/nested`, `${h.dir}/link-to-dir`)
    h.cb!('rename', 'link-to-dir')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][0]).toBe('link-to-dir')
  })

  it('logs a file again after a known file was replaced by a directory and back', () => {
    writeFileSync(`${h.dir}/swap`, 'a')
    stopStoreWatcher()
    startStoreWatcher() // swap is now a known file
    rmSync(`${h.dir}/swap`)
    mkdirSync(`${h.dir}/swap`)
    h.cb!('rename', 'swap')
    rmSync(`${h.dir}/swap`, { recursive: true })
    writeFileSync(`${h.dir}/swap`, 'bb')
    h.cb!('rename', 'swap')
    expect(logStoreFileEvent).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logStoreFileEvent).mock.calls[0][0]).toBe('swap')
  })

  it('does not log a file that was already there at start', () => {
    h.cb!('rename', 'existing-dir/known.txt')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })
})
