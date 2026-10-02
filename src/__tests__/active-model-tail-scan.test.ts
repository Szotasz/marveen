import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { constants } from 'node:buffer'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  projectsDirFor,
  readActiveModelFromProjectDir,
  readContextTokensFromProjectDir,
  resetTranscriptScansForTests,
  transcriptScanBytesReadForTests,
} from '../web/active-model.js'

// df2e0d97 2b: the active-model and context-token readers read the newest transcript from its end, only as far back
// as the answer needs, and per transcript only the bytes appended since the last call. The answers must stay the old
// whole-file backward scan's, which is kept here as the reference; past V8's string limit the old scan could not
// answer at all (the last describe).

function oldActiveModel(content: string, sinceUnixSec?: number): string | null {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      const model = entry?.message?.model
      if (typeof model !== 'string' || model.startsWith('<')) continue
      if (sinceUnixSec !== undefined) {
        const ts = entry?.timestamp
        if (typeof ts !== 'string') continue
        const lineUnix = Math.floor(new Date(ts).getTime() / 1000)
        if (!Number.isFinite(lineUnix) || lineUnix < sinceUnixSec) continue
      }
      return model
    } catch { /* skip malformed JSON line */ }
  }
  return null
}

function oldContextTokens(content: string): number | null {
  const lines = content.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const u = JSON.parse(line)?.message?.usage
      if (u && typeof u === 'object') {
        const total = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
        if (total > 0) return total
      }
    } catch { /* skip malformed JSON line */ }
  }
  return null
}

// A seeded generator with exact 32-bit steps (Math.imul), so a case is reproducible from its seed.
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0
  return (n: number) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return (s >>> 16) % n
  }
}

const BASE_MS = Date.UTC(2026, 9, 2, 12, 0, 0)
function iso(sec: number): string { return new Date(BASE_MS + sec * 1000).toISOString() }

function randomLine(r: (n: number) => number): string {
  const ts = iso(r(4000))
  switch (r(9)) {
    case 0: return JSON.stringify({ type: 'assistant', timestamp: ts, message: { model: `claude-model-${r(5)}`, usage: { input_tokens: r(3) * 100, cache_read_input_tokens: r(2) * 1000 } } })
    case 1: return JSON.stringify({ type: 'assistant', timestamp: ts, message: { model: '<synthetic>', usage: { input_tokens: 0 } } })
    case 2: return JSON.stringify({ type: 'assistant', timestamp: r(2) ? 'not a date' : 17, message: { model: `claude-model-${r(5)}` } })
    case 3: return JSON.stringify({ type: 'user', timestamp: ts, message: { content: `árvíztűrő tükörfúrógép ${'ő'.repeat(r(50))}` } })
    case 4: return '{"type":"assistant","message":{"model":"broken'
    case 5: return r(2) ? '' : '   '
    case 6: return `  ${JSON.stringify({ type: 'assistant', timestamp: ts, message: { usage: { cache_creation_input_tokens: r(4) * 7 } } })}  `
    case 7: return JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'x'.repeat(r(4) === 0 ? 300_000 + r(1000) : r(100)) } })
    default: return JSON.stringify({ type: 'system', timestamp: ts, content: 'bookkeeping' })
  }
}

let root: string
let workingDir: string
let configDir: string
let file: string
let clock = BASE_MS

function readers(since?: number): { model: string | null; tokens: number | null } {
  // past the readers' 3 s result cache, so every call reaches the scan
  clock += 10_000
  vi.setSystemTime(clock)
  return {
    model: readActiveModelFromProjectDir(workingDir, since, configDir),
    tokens: readContextTokensFromProjectDir(workingDir, configDir),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  root = mkdtempSync(join(tmpdir(), 'tail-scan-'))
  workingDir = join(root, 'agent')
  configDir = join(root, 'config')
  const dir = projectsDirFor(workingDir, configDir)
  mkdirSync(dir, { recursive: true })
  file = join(dir, 'session.jsonl')
  resetTranscriptScansForTests()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('the answers are the whole-file scan\'s', () => {
  it('on 300 random transcripts (long lines across the 256 KiB chunks, accents, blank, padded and broken lines, with and without a final newline)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const lines = Array.from({ length: 1 + r(40) }, () => randomLine(r))
      const content = lines.join('\n') + (r(2) ? '\n' : '')
      writeFileSync(file, content)
      resetTranscriptScansForTests()
      const since = r(3) === 0 ? undefined : Math.floor(BASE_MS / 1000) + r(4000)
      const got = readers(since)
      expect(got.model, `seed ${seed}`).toBe(oldActiveModel(content, since))
      expect(got.tokens, `seed ${seed}`).toBe(oldContextTokens(content))
    }
  })

  it('and after random appends, read incrementally, on the same transcript', () => {
    for (let seed = 1001; seed <= 1060; seed++) {
      const r = rng(seed)
      let content = ''
      writeFileSync(file, '')
      resetTranscriptScansForTests()
      const since = r(2) ? undefined : Math.floor(BASE_MS / 1000) + r(4000)
      for (let step = 0; step < 8; step++) {
        // an append may end in the middle of a line, as a writer's partial write does
        const add = Array.from({ length: r(6) }, () => randomLine(r)).join('\n') + (r(3) ? '\n' : '')
        appendFileSync(file, add)
        content += add
        const got = readers(since)
        expect(got.model, `seed ${seed} step ${step}`).toBe(oldActiveModel(content, since))
        expect(got.tokens, `seed ${seed} step ${step}`).toBe(oldContextTokens(content))
      }
    }
  })
})

describe('what is read', () => {
  const filler = (n: number): string => Array.from({ length: n }, (_, i) =>
    JSON.stringify({ type: 'user', timestamp: iso(i % 3000), message: { content: `sor ${i} ${'y'.repeat(200)}` } })).join('\n') + '\n'
  const modelLine = (model: string, sec: number): string =>
    JSON.stringify({ type: 'assistant', timestamp: iso(sec), message: { model, usage: { input_tokens: 10, cache_read_input_tokens: 990 } } }) + '\n'

  it('an answer near the end of an 8 MB transcript reads its last chunk only; an unchanged transcript is not read again; an append reads the new bytes', () => {
    const big = filler(36_000) + modelLine('claude-old', 3500) + filler(5)
    writeFileSync(file, big)
    expect(big.length).toBeGreaterThan(8_000_000)
    let before = transcriptScanBytesReadForTests()
    expect(readers()).toEqual({ model: 'claude-old', tokens: 1000 })
    // two readers, each one 256 KiB chunk (and a 64-byte anchor) at most
    expect(transcriptScanBytesReadForTests() - before).toBeLessThan(2 * (256 * 1024 + 64) + 1)

    before = transcriptScanBytesReadForTests()
    expect(readers()).toEqual({ model: 'claude-old', tokens: 1000 })
    expect(transcriptScanBytesReadForTests() - before).toBe(0)

    const add = filler(3) + modelLine('claude-new', 3600)
    appendFileSync(file, add)
    before = transcriptScanBytesReadForTests()
    expect(readers()).toEqual({ model: 'claude-new', tokens: 1000 })
    expect(transcriptScanBytesReadForTests() - before).toBeLessThan(2 * (add.length + 64 + 64) + 1)
  })

  it('a fresh session after a restart (all model lines older than since): the first call reads the file, the next ones only what was appended', () => {
    const since = Math.floor(BASE_MS / 1000) + 3900
    writeFileSync(file, filler(20_000) + modelLine('claude-before-restart', 3000))
    expect(readers(since).model).toBeNull()

    let before = transcriptScanBytesReadForTests()
    expect(readers(since).model).toBeNull()
    expect(transcriptScanBytesReadForTests() - before).toBe(0)

    const bookkeeping = JSON.stringify({ type: 'system', timestamp: iso(3950), content: 'hook' }) + '\n'
    appendFileSync(file, bookkeeping)
    before = transcriptScanBytesReadForTests()
    expect(readers(since).model).toBeNull()
    expect(transcriptScanBytesReadForTests() - before).toBeLessThan(2 * (bookkeeping.length + 64 + 64) + 1)

    const turn = modelLine('claude-after-restart', 3960)
    appendFileSync(file, turn)
    before = transcriptScanBytesReadForTests()
    expect(readers(since).model).toBe('claude-after-restart')
    expect(transcriptScanBytesReadForTests() - before).toBeLessThan(2 * (turn.length + 64 + 64) + 1)
  })

  it('two callers with different since values on one transcript keep their own answers', () => {
    writeFileSync(file, modelLine('claude-early', 1000) + modelLine('claude-late', 2000) + filler(3))
    const s1 = Math.floor(BASE_MS / 1000) + 500
    const s2 = Math.floor(BASE_MS / 1000) + 2500
    expect(readers(s1).model).toBe('claude-late')
    expect(readers(s2).model).toBeNull()
    expect(readers(s1).model).toBe('claude-late')
    expect(readers(undefined).model).toBe('claude-late')
    expect(readers(s2).model).toBeNull()
  })

  it('an answer line longer than two chunks (it spans three 256 KiB reads) is read whole', () => {
    const long = JSON.stringify({ type: 'assistant', timestamp: iso(3700), message: { model: 'claude-long', usage: { input_tokens: 7 }, content: 'ű'.repeat(400_000) } }) + '\n'
    expect(Buffer.byteLength(long)).toBeGreaterThan(3 * 256 * 1024)
    writeFileSync(file, filler(5) + long + filler(2))
    expect(readers()).toEqual({ model: 'claude-long', tokens: 7 })
  })

  it('a line cut by an unfinished write is read whole once it is finished', () => {
    const line = modelLine('claude-split', 3800)
    writeFileSync(file, filler(10) + line.slice(0, 40))
    expect(readers().model).toBeNull()
    appendFileSync(file, line.slice(40))
    expect(readers().model).toBe('claude-split')
  })
})

describe('a transcript that is not only appended to is read whole', () => {
  const modelLine = (model: string): string => JSON.stringify({ type: 'assistant', timestamp: iso(100), message: { model } }) + '\n'

  it('replaced by another file (rename over it)', () => {
    writeFileSync(file, modelLine('claude-a'))
    expect(readers().model).toBe('claude-a')
    const other = file + '.uj'
    writeFileSync(other, modelLine('claude-b') + modelLine('claude-c') + '{"x":1}\n')
    renameSync(other, file)
    expect(readers().model).toBe('claude-c')
  })

  it('truncated', () => {
    writeFileSync(file, modelLine('claude-a') + modelLine('claude-b'))
    expect(readers().model).toBe('claude-b')
    truncateSync(file, modelLine('claude-a').length)
    expect(readers().model).toBe('claude-a')
  })

  it('rewritten in place to the SAME size (another mtime) with the end untouched: read whole, not from the last line', () => {
    const tail = '{"type":"system","note":"' + 'w'.repeat(100) + '"}\n'
    writeFileSync(file, modelLine('claude-a') + tail)
    expect(readers().model).toBe('claude-a')
    writeFileSync(file, modelLine('claude-b') + tail)
    // the file system's mtime clock is coarse: two writes inside one tick may share it, so the test sets it apart
    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later)
    expect(readers().model).toBe('claude-b')
  })

  it('rewritten in place to a larger size (the same inode): the anchor before the last line no longer matches', () => {
    writeFileSync(file, modelLine('claude-a') + '{"type":"system"}\n')
    expect(readers().model).toBe('claude-a')
    writeFileSync(file, '{"type":"system","x":"' + 'z'.repeat(40) + '"}\n' + modelLine('claude-b').replace('claude-b', 'claude-b-longer') + '{"type":"system"}\n')
    expect(readers().model).toBe('claude-b-longer')
  })
})

describe('a transcript past V8\'s string limit', () => {
  // The old readers decoded the whole transcript into one string (readFileSync(file, 'utf-8')). Past the engine's
  // string limit that threw inside their try, after every byte was read, so they answered null: the dashboard showed
  // no model and no context for such a session, and the context guard could not measure it. The file here is sparse
  // (a hole of NUL bytes before the last line), so its size costs neither disk nor memory.
  it('still answers, from its last chunk', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: iso(3900), message: { model: 'claude-huge', usage: { input_tokens: 5, cache_read_input_tokens: 95 } } }) + '\n'
    writeFileSync(file, '')
    truncateSync(file, constants.MAX_STRING_LENGTH + 1_000_000)
    appendFileSync(file, '\n' + line)
    expect(statSync(file).size).toBeGreaterThan(constants.MAX_STRING_LENGTH)
    const before = transcriptScanBytesReadForTests()
    expect(readers()).toEqual({ model: 'claude-huge', tokens: 100 })
    expect(transcriptScanBytesReadForTests() - before).toBeLessThan(2 * (256 * 1024 + 64) + 1)
  })
})
