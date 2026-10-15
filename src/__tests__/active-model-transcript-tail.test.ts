// readTranscriptTailFromProjectDir against a real temp directory. The only
// seam is readSync, wrapped so one case can make it return fewer bytes than
// asked -- what a file that shrinks between the fstat and the read does; every
// other case goes straight through to the real call.
//
// CONTROLS, run against the first version of this reader (no per-file stat
// guard, the whole buffer decoded): "a vanished file" fails there (one
// dangling entry made the whole read return null) and "a short read" fails
// there (the tail came back padded with NUL bytes). The other cases pass on
// both and pin the behaviour the fix must keep.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ shortBy: 0 }))

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    readSync: ((fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) =>
      real.readSync(fd, buf, offset, Math.max(0, length - h.shortBy), position)) as typeof real.readSync,
  }
})

const { readTranscriptTailFromProjectDir, projectsDirFor } = await import('../web/active-model.js')

const ROOT = mkdtempSync(join(tmpdir(), 'tail-read-test-'))
const WORK = '/srv/agent-work'
const CFG = join(ROOT, 'cfg')
const DIR = projectsDirFor(WORK, CFG)

function writeAt(name: string, content: string, mtimeSec: number): void {
  const p = join(DIR, name)
  writeFileSync(p, content)
  utimesSync(p, mtimeSec, mtimeSec)
}

beforeEach(() => {
  rmSync(CFG, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  h.shortBy = 0
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('readTranscriptTailFromProjectDir', () => {
  it('absent project dir -> null', () => {
    rmSync(CFG, { recursive: true, force: true })
    expect(readTranscriptTailFromProjectDir(WORK, CFG)).toBeNull()
  })

  it('no jsonl in the dir -> null', () => {
    writeFileSync(join(DIR, 'notes.txt'), 'x')
    expect(readTranscriptTailFromProjectDir(WORK, CFG)).toBeNull()
  })

  it('file smaller than maxBytes -> the whole file', () => {
    writeAt('a.jsonl', '{"a":1}\n{"b":2}\n', 1_000)
    expect(readTranscriptTailFromProjectDir(WORK, CFG, 4096)).toBe('{"a":1}\n{"b":2}\n')
  })

  it('file larger than maxBytes -> exactly the last maxBytes bytes, from the right offset', () => {
    const content = Array.from({ length: 50 }, (_, i) => `{"n":${i}}`).join('\n') + '\n'
    writeAt('a.jsonl', content, 1_000)
    expect(readTranscriptTailFromProjectDir(WORK, CFG, 40)).toBe(content.slice(-40))
  })

  it('the first line of the tail is cut mid-entry and returned as is', () => {
    const content = '{"first":"aaaaaaaaaa"}\n{"second":"bbbb"}\n'
    writeAt('a.jsonl', content, 1_000)
    const tail = readTranscriptTailFromProjectDir(WORK, CFG, 26)!
    expect(tail).toBe(content.slice(-26))
    const [cut, whole] = tail.split('\n')
    expect(() => JSON.parse(cut)).toThrow()
    expect(JSON.parse(whole)).toEqual({ second: 'bbbb' })
  })

  it('reads the NEWEST jsonl by mtime', () => {
    writeAt('old.jsonl', 'old\n', 1_000)
    writeAt('new.jsonl', 'new\n', 2_000)
    expect(readTranscriptTailFromProjectDir(WORK, CFG)).toBe('new\n')
  })

  it('a vanished file (listed, then gone at stat) is skipped, not fatal', () => {
    writeAt('live.jsonl', 'live\n', 1_000)
    // A dangling symlink is listed by readdir and fails stat with ENOENT: the
    // same thing a transcript removed between the two calls looks like.
    symlinkSync(join(DIR, 'gone-target.jsonl'), join(DIR, 'gone.jsonl'))
    expect(readTranscriptTailFromProjectDir(WORK, CFG)).toBe('live\n')
  })

  it('a short read decodes only the bytes actually read (no NUL padding)', () => {
    writeAt('a.jsonl', '{"a":1}\n{"b":2}\n', 1_000)
    h.shortBy = 3
    const tail = readTranscriptTailFromProjectDir(WORK, CFG, 4096)!
    expect(tail).not.toContain('\u0000')
    expect(tail).toBe('{"a":1}\n{"b":2}\n'.slice(0, -3))
  })
})
