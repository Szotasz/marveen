import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { EventEmitter } from 'node:events'

const h = vi.hoisted(() => ({
  dir: `${process.env.TMPDIR || '/tmp'}/marveen-store-watcher-exclude-test-${process.pid}`,
  records: [] as {
    dir: string
    opts: { recursive?: boolean }
    cb: (eventType: string, filename: string | null) => void
    w: EventEmitter & { close: ReturnType<typeof vi.fn> }
  }[],
  failDir: null as string | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter } = await import('node:events')
  const watch = ((dir: unknown, opts: { recursive?: boolean }, cb: (e: string, f: string | null) => void) => {
    const w = Object.assign(new EventEmitter(), { close: vi.fn() })
    h.records.push({ dir: String(dir), opts, cb, w })
    if (String(dir) === h.failDir) throw new Error('watch failed')
    return w
  }) as unknown as typeof actual.watch
  return { ...actual, watch, default: { ...actual, watch } }
})

vi.mock('../config.js', () => ({ STORE_DIR: h.dir }))
vi.mock('../db.js', () => ({ logStoreFileEvent: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { clearStoreWriteActor, setStoreWriteActor, startStoreWatcher, stopStoreWatcher } from '../store-watcher.js'
import { logStoreFileEvent } from '../db.js'
import { logger } from '../logger.js'

const { parseStoreWatchExclude } = await vi.importActual<typeof import('../config.js')>('../config.js')

const recorded = (name = '') => h.records.find(r => r.dir === (name ? `${h.dir}/${name}` : h.dir))!
const startedInfo = () => vi.mocked(logger.info).mock.calls.find(c => c[1] === 'Store file watcher started')![0]
const announceFresh = () => {
  mkdirSync(`${h.dir}/fresh`)
  recorded().cb('rename', 'fresh')
  return recorded('fresh')
}

beforeEach(() => {
  vi.clearAllMocks()
  clearStoreWriteActor()
  h.failDir = null
  rmSync(h.dir, { recursive: true, force: true })
  mkdirSync(`${h.dir}/heavy/deep`, { recursive: true })
  mkdirSync(`${h.dir}/kept/sub`, { recursive: true })
  writeFileSync(`${h.dir}/heavy/deep/f1.txt`, 'x')
  writeFileSync(`${h.dir}/heavy/deep/f2.txt`, 'x')
  writeFileSync(`${h.dir}/kept/sub/known.txt`, 'x')
  writeFileSync(`${h.dir}/top.txt`, 'x')
  symlinkSync(`${h.dir}/kept`, `${h.dir}/link`)
})

afterEach(() => {
  stopStoreWatcher()
  h.records.length = 0
  rmSync(h.dir, { recursive: true, force: true })
})

describe('store-watcher: top-level exclusions', () => {
  it('parses unset, trimmed, duplicate, and invalid exclusion entries', () => {
    expect(parseStoreWatchExclude(undefined)).toEqual(new Set())
    expect(parseStoreWatchExclude(' a , b,,a ')).toEqual(new Set(['a', 'b']))
    for (const raw of ['.', '..', 'x/y', 'x\\y', 'x\u0000y', '']) {
      expect(parseStoreWatchExclude(raw)).toEqual(new Set())
    }
  })

  it('keeps exactly one recursive root watch with no options or an empty exclusion list', () => {
    startStoreWatcher()
    expect(h.records).toHaveLength(1)
    expect(recorded().opts.recursive).toBe(true)
    stopStoreWatcher()
    h.records.length = 0
    startStoreWatcher({ exclude: [] })
    expect(h.records).toHaveLength(1)
    expect(recorded().opts.recursive).toBe(true)
  })

  it('watches the root non-recursively and only included real directories recursively', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    expect(recorded().opts.recursive).toBe(false)
    expect(recorded('kept').opts.recursive).toBe(true)
    expect(h.records.some(r => r.dir === `${h.dir}/heavy` || r.dir.startsWith(`${h.dir}/heavy/`))).toBe(false)
    expect(h.records.some(r => r.dir === `${h.dir}/link`)).toBe(false)
    expect(h.records).toHaveLength(2)
  })

  it('counts all five scanned files by default, including the directory symlink', () => {
    startStoreWatcher()
    expect(startedInfo()).toMatchObject({ knownCount: 5, excluded: [], subWatchers: 0 })
  })

  it('omits the excluded tree from the startup scan and reports its sub-watcher count', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    expect(startedInfo()).toMatchObject({ knownCount: 3, excluded: ['heavy'], subWatchers: 1 })
  })

  it('logs a new kept file with its full relative path and size, but skips scanned files', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    writeFileSync(`${h.dir}/kept/sub/new.txt`, 'hello')
    recorded('kept').cb('rename', 'sub/new.txt')
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('kept/sub/new.txt', 'create', 0, 5, null)
    vi.mocked(logStoreFileEvent).mockClear()
    recorded('kept').cb('rename', 'sub/known.txt')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
  })

  it('ignores excluded root and nested events without starting another watcher', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    recorded().cb('rename', 'heavy')
    writeFileSync(`${h.dir}/heavy/deep/f3.txt`, 'hello')
    recorded().cb('rename', 'heavy/deep/f3.txt')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    expect(h.records).toHaveLength(2)
  })

  it('starts one watcher for a new included directory and none for a new excluded directory', () => {
    startStoreWatcher({ exclude: ['heavy', 'later'] })
    const fresh = announceFresh()
    mkdirSync(`${h.dir}/later`)
    recorded().cb('rename', 'fresh')
    recorded().cb('rename', 'later')
    expect(h.records).toHaveLength(3)
    expect(fresh.opts.recursive).toBe(true)
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    writeFileSync(`${h.dir}/fresh/a.txt`, 'hello')
    fresh.cb('rename', 'a.txt')
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('fresh/a.txt', 'create', 0, 5, null)
  })

  it('closes and removes the sub-watcher when a top-level directory disappears', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    const fresh = announceFresh()
    rmSync(`${h.dir}/fresh`, { recursive: true })
    recorded().cb('rename', 'fresh')
    expect(fresh.w.close).toHaveBeenCalledTimes(1)
    stopStoreWatcher()
    expect(fresh.w.close).toHaveBeenCalledTimes(1)
  })

  it('logs a new top-level file through the root watcher', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    writeFileSync(`${h.dir}/new-top.txt`, 'hello')
    recorded().cb('rename', 'new-top.txt')
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('new-top.txt', 'create', 0, 5, null)
  })

  it('closes every watcher exactly once when stopped', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    stopStoreWatcher()
    stopStoreWatcher()
    for (const { w } of h.records) expect(w.close).toHaveBeenCalledTimes(1)
  })

  it.each([[], ['heavy']])('attaches one error listener to every watcher with exclusions %j', (...exclude) => {
    startStoreWatcher({ exclude })
    for (const { w } of h.records) {
      expect(w.listenerCount('error')).toBe(1)
      expect(() => w.emit('error', Object.assign(new Error('unreadable'), { code: 'EACCES', path: '/locked' }))).not.toThrow()
    }
    // The same pair is reported once across all watchers.
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('consumes the actor slot for an excluded event', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    setStoreWriteActor('dashboard')
    recorded().cb('rename', 'heavy')
    writeFileSync(`${h.dir}/new2.txt`, 'hello')
    recorded().cb('rename', 'new2.txt')
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('new2.txt', 'create', 0, 5, null)
  })

  it('keeps the re-entry guard in both modes', () => {
    startStoreWatcher()
    startStoreWatcher()
    expect(h.records).toHaveLength(1)
    stopStoreWatcher()
    h.records.length = 0
    startStoreWatcher({ exclude: ['heavy'] })
    startStoreWatcher({ exclude: ['heavy'] })
    expect(h.records).toHaveLength(2)
  })

  it('skips a subdirectory whose watch fails and continues watching other directories', () => {
    mkdirSync(`${h.dir}/another`)
    h.failDir = `${h.dir}/another`
    startStoreWatcher({ exclude: ['heavy'] })
    expect(recorded('kept').opts.recursive).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), dir: 'another' },
      'store-watcher: subdirectory watch failed to start',
    )
    expect(startedInfo()).toMatchObject({ subWatchers: 1 })
  })

  it('does not exclude a top-level file whose name is in the list', () => {
    startStoreWatcher({ exclude: ['top.txt'] })
    expect(startedInfo()).toMatchObject({ knownCount: 5 })
    recorded().cb('rename', 'top.txt')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    stopStoreWatcher()
    vi.clearAllMocks()
    h.records.length = 0
    startStoreWatcher({ exclude: ['reserved'] })
    writeFileSync(`${h.dir}/reserved`, 'abc')
    recorded().cb('rename', 'reserved')
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('reserved', 'create', 0, 3, null)
    expect(h.records.some(r => r.dir === `${h.dir}/reserved`)).toBe(false)
  })

  it('a top-level file that becomes an excluded directory and then a file again is logged', () => {
    writeFileSync(`${h.dir}/flip`, 'a')
    startStoreWatcher({ exclude: ['flip'] })
    expect(startedInfo()).toMatchObject({ knownCount: 6 })

    rmSync(`${h.dir}/flip`)
    mkdirSync(`${h.dir}/flip`)
    recorded().cb('rename', 'flip')
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    expect(h.records.some(r => r.dir === `${h.dir}/flip`)).toBe(false)

    rmSync(`${h.dir}/flip`, { recursive: true, force: true })
    writeFileSync(`${h.dir}/flip`, 'abcde')
    recorded().cb('rename', 'flip')
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('flip', 'create', 0, 5, null)
  })

  it('a top-level symlink whose name is in the list is still scanned', () => {
    startStoreWatcher({ exclude: ['link'] })
    expect(startedInfo()).toMatchObject({ knownCount: 5 })
    expect(h.records.some(r => r.dir === `${h.dir}/link`)).toBe(false)
  })

  it('an excluded directory created after start gets no watcher and clears the actor slot', () => {
    startStoreWatcher({ exclude: ['later'] })
    mkdirSync(`${h.dir}/later`)
    setStoreWriteActor('dashboard')
    recorded().cb('rename', 'later')
    expect(h.records.some(r => r.dir === `${h.dir}/later`)).toBe(false)
    expect(logStoreFileEvent).not.toHaveBeenCalled()
    writeFileSync(`${h.dir}/after.txt`, 'x')
    recorded().cb('rename', 'after.txt')
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('after.txt', 'create', 0, 1, null)
  })

  it('a top-level directory replaced by a file closes its sub-watcher and logs the file', () => {
    startStoreWatcher({ exclude: ['heavy'] })
    const sub = recorded('kept')
    rmSync(`${h.dir}/kept`, { recursive: true, force: true })
    writeFileSync(`${h.dir}/kept`, 'abcd')
    recorded().cb('rename', 'kept')
    expect(sub.w.close).toHaveBeenCalledTimes(1)
    expect(logStoreFileEvent).toHaveBeenCalledExactlyOnceWith('kept', 'create', 0, 4, null)
  })
})
