// Tests for collectLocalFiles error-resilience and system-dir skip logic.
//
// Validates:
//   1. An unreadable directory (readdirSync throws) is SKIPPED with a warn log;
//      sibling directories and files are still collected.
//   2. Directories in the system skip-list (.Trash, hidden dot-dirs) are skipped
//      without error; a warn is logged.
//   3. The dirsSkipped counter increments correctly for both cases.
//   4. A recursion error in a subdir is caught per-dir; other subdirs continue.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module mocks (must come before imports) ───────────────────────────────────

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, readdirSync: vi.fn(), existsSync: vi.fn() }
})

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  runLinkMaintenance: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import * as fs from 'node:fs'
import { collectLocalFiles, type CollectOpts } from '../web/import-crawler.js'
import * as loggerModule from '../logger.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOpts(): CollectOpts {
  return { depth: 0, dirsSkipped: { count: 0 } }
}

// Build a minimal Dirent-like object for mocking
function mockDirent(name: string, type: 'file' | 'dir'): ReturnType<typeof fs.readdirSync>[0] {
  return {
    name,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    parentPath: '',
    path: '',
  } as unknown as ReturnType<typeof fs.readdirSync>[0]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('collectLocalFiles -- error resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fs.existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('collects files from a normal directory', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('a.txt', 'file'),
      mockDirent('b.md', 'file'),
    ] as any)

    const results: string[] = []
    const opts = makeOpts()
    collectLocalFiles('/fake/root', results, opts)

    expect(results).toEqual(['/fake/root/a.txt', '/fake/root/b.md'])
    expect(opts.dirsSkipped.count).toBe(0)
    expect(vi.mocked(loggerModule.logger.warn)).not.toHaveBeenCalled()
  })

  it('skips an unreadable directory (readdirSync throws) and logs warn; sibling files still collected', () => {
    // Root: one normal file + one unreadable subdirectory + one normal subdir
    const EACCES = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })

    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce([
        // root directory listing
        mockDirent('good.txt', 'file'),
        mockDirent('broken-dir', 'dir'),
        mockDirent('ok-dir', 'dir'),
      ] as any)
      .mockImplementationOnce(() => { throw EACCES })  // broken-dir throws
      .mockReturnValueOnce([mockDirent('nested.txt', 'file')] as any)  // ok-dir ok

    const results: string[] = []
    const opts = makeOpts()
    collectLocalFiles('/fake/root', results, opts)

    expect(results).toContain('/fake/root/good.txt')
    expect(results).toContain('/fake/root/ok-dir/nested.txt')
    expect(results).not.toContain(expect.stringContaining('broken-dir'))
    expect(opts.dirsSkipped.count).toBe(1)
    expect(vi.mocked(loggerModule.logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ dirPath: '/fake/root/broken-dir' }),
      expect.stringContaining('skipping unreadable directory'),
    )
  })

  it('skips an Unknown system error -11 (OneDrive .Trash EUNKNOWN) and continues', () => {
    const EUNKNOWN = Object.assign(new Error('Unknown system error -11'), { code: 'EUNKNOWN', errno: -11 })

    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce([
        mockDirent('doc.txt', 'file'),
        mockDirent('bad-cloud-dir', 'dir'),
      ] as any)
      .mockImplementationOnce(() => { throw EUNKNOWN })

    const results: string[] = []
    const opts = makeOpts()
    collectLocalFiles('/fake/root', results, opts)

    expect(results).toEqual(['/fake/root/doc.txt'])
    expect(opts.dirsSkipped.count).toBe(1)
    expect(vi.mocked(loggerModule.logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ dirPath: '/fake/root/bad-cloud-dir' }),
      expect.stringContaining('skipping unreadable directory'),
    )
  })

  it('skips .Trash directory (system skip-list) with warn, without trying to read it', () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      mockDirent('real-file.txt', 'file'),
      mockDirent('.Trash', 'dir'),
      mockDirent('another.md', 'file'),
    ] as any)

    const results: string[] = []
    const opts = makeOpts()
    collectLocalFiles('/fake/root', results, opts)

    expect(results).toContain('/fake/root/real-file.txt')
    expect(results).toContain('/fake/root/another.md')
    // readdirSync must only be called for root, NOT for .Trash
    expect(vi.mocked(fs.readdirSync)).toHaveBeenCalledTimes(1)
    expect(opts.dirsSkipped.count).toBe(1)
    expect(vi.mocked(loggerModule.logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/fake/root/.Trash' }),
      expect.stringContaining('system/cloud internal directory'),
    )
  })

  it('skips arbitrary hidden dot-directories', () => {
    vi.mocked(fs.readdirSync).mockReturnValueOnce([
      mockDirent('visible-file.txt', 'file'),
      mockDirent('.hidden-cloud-cache', 'dir'),
    ] as any)

    const results: string[] = []
    const opts = makeOpts()
    collectLocalFiles('/fake/root', results, opts)

    expect(results).toEqual(['/fake/root/visible-file.txt'])
    expect(opts.dirsSkipped.count).toBe(1)
  })

  it('accumulates dirsSkipped count across multiple bad dirs', () => {
    const ERR = new Error('EPERM')

    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce([
        mockDirent('good.txt', 'file'),
        mockDirent('bad1', 'dir'),
        mockDirent('bad2', 'dir'),
        mockDirent('.hidden-dir', 'dir'),  // system skip
      ] as any)
      .mockImplementationOnce(() => { throw ERR })  // bad1
      .mockImplementationOnce(() => { throw ERR })  // bad2

    const results: string[] = []
    const opts = makeOpts()
    collectLocalFiles('/fake/root', results, opts)

    expect(results).toEqual(['/fake/root/good.txt'])
    // 2 read errors + 1 system skip = 3
    expect(opts.dirsSkipped.count).toBe(3)
  })

  it('does not skip normal (non-hidden) directories', () => {
    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce([mockDirent('subdir', 'dir')] as any)
      .mockReturnValueOnce([mockDirent('file.txt', 'file')] as any)

    const results: string[] = []
    const opts = makeOpts()
    collectLocalFiles('/fake/root', results, opts)

    expect(results).toEqual(['/fake/root/subdir/file.txt'])
    expect(opts.dirsSkipped.count).toBe(0)
    expect(vi.mocked(loggerModule.logger.warn)).not.toHaveBeenCalled()
  })
})
