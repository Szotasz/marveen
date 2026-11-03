import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUserTurnCounter } from '../web/user-turns.js'

// GET /api/overview used to count user turns by re-reading every session transcript
// under the projects root in full, twice per request. That counter is kept here,
// unchanged apart from taking `root`, as the reference (`oldCount`); the incremental
// one must answer exactly the same for any window, while reading only what was
// appended since its last call.
function oldCount(root: string, fromMs: number, toMs: number = Number.POSITIVE_INFINITY): number {
  if (!existsSync(root)) return 0
  let total = 0
  try {
    for (const projectDir of readdirSync(root)) {
      const absDir = join(root, projectDir)
      let stat: ReturnType<typeof statSync>
      try { stat = statSync(absDir) } catch { continue }
      if (!stat.isDirectory()) continue
      for (const fname of readdirSync(absDir)) {
        if (!fname.endsWith('.jsonl')) continue
        const absFile = join(absDir, fname)
        let fstat: ReturnType<typeof statSync>
        try { fstat = statSync(absFile) } catch { continue }
        if (fstat.mtimeMs < fromMs) continue
        try {
          const data = readFileSync(absFile, 'utf-8')
          for (const line of data.split('\n')) {
            if (!line) continue
            let e: any
            try { e = JSON.parse(line) } catch { continue }
            if (e.type !== 'user' || e.isMeta) continue
            const ts = e.timestamp ? Date.parse(e.timestamp) : 0
            if (!ts || ts < fromMs || ts >= toMs) continue
            const content = e.message?.content
            if (typeof content === 'string') {
              if (content.startsWith('<local-command') || content.startsWith('<command-name>')) continue
              total++
            } else if (Array.isArray(content)) {
              const hasToolResult = content.some((b: any) => b && b.type === 'tool_result')
              if (hasToolResult) continue
              total++
            }
          }
        } catch { /* skip unreadable file */ }
      }
    }
  } catch { /* ignore */ }
  return total
}

const BASE_MS = Date.UTC(2026, 9, 2, 12, 0, 0)
const at = (sec: number): number => BASE_MS + sec * 1000
const iso = (sec: number): string => new Date(at(sec)).toISOString()
const userLine = (sec: number, content: unknown = 'operator prompt'): string =>
  JSON.stringify({ type: 'user', timestamp: iso(sec), message: { content } })

// A seeded generator with exact 32-bit steps (Math.imul), so a case is reproducible from its seed.
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0
  return (n: number) => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0
    return (s >>> 16) % n
  }
}

function randomLine(r: (n: number) => number): string {
  switch (r(10)) {
    case 0: return userLine(r(4000))
    case 1: return userLine(r(4000), '<local-command-stdout>model set</local-command-stdout>')
    case 2: return userLine(r(4000), '<command-name>/clear</command-name>')
    case 3: return userLine(r(4000), [{ type: 'text', text: `multibyte text ñ ${r(50)} 🎉` }])
    case 4: return userLine(r(4000), [{ type: 'tool_result', content: 'x'.repeat(r(30)) }])
    case 5: return JSON.stringify({ type: 'user', isMeta: r(2) === 0, timestamp: iso(r(4000)), message: { content: 'maybe meta' } })
    case 6: return JSON.stringify({ type: 'assistant', timestamp: iso(r(4000)), message: { content: 'reply ç 🎊' } })
    case 7: return '{"type":"user","timestamp":"brok'
    case 8: return r(2) ? '' : '   '
    default: return JSON.stringify({ type: 'user', message: { content: 'no timestamp ø' } })
  }
}

let root: string
let counter: ReturnType<typeof createUserTurnCounter>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'user-turns-'))
  counter = createUserTurnCounter(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function project(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

// A deliberate difference from the whole-file counter (the other one, a line that
// parses to null, has its own test below), spelled out in the title below: a line written without its trailing newline is held back until
// the newline arrives, because the byte that terminates it may never be
// written (a crash mid-write) and half a JSON line never qualifies.
describe('the incremental counter answers what the whole-file one did, except that an unfinished last line waits for its newline', () => {
  it('on every line kind, two projects, three transcripts and several windows', () => {
    const a = project('proj-a')
    const b = project('proj-b')
    writeFileSync(join(a, 's1.jsonl'), [
      userLine(100),
      userLine(200, '<local-command-stdout>model set</local-command-stdout>'),
      userLine(300, '<command-name>/model</command-name>'),
      userLine(400, [{ type: 'text', text: 'real prompt' }]),
      userLine(500, [{ type: 'tool_result', content: 'ok' }]),
      JSON.stringify({ type: 'user', isMeta: true, timestamp: iso(600), message: { content: 'synthetic' } }),
      JSON.stringify({ type: 'assistant', timestamp: iso(700), message: { content: 'reply' } }),
      '{"type":"user","timestamp":"broken',
      JSON.stringify({ type: 'user', message: { content: 'no timestamp' } }),
      '',
      userLine(3600),
    ].join('\n') + '\n')
    writeFileSync(join(a, 's2.jsonl'), userLine(150) + '\n' + userLine(250) + '\n')
    writeFileSync(join(b, 's3.jsonl'), userLine(50, 'please write a summary ñ 🎉') + '\n' + userLine(1000) + '\n')
    writeFileSync(join(a, 'notes.txt'), userLine(125) + '\n') // not a transcript
    writeFileSync(join(root, 'stray.jsonl'), userLine(175) + '\n') // not in a project dir

    const windows: Array<[number, number | undefined]> = [
      [0, undefined],
      [BASE_MS, undefined],
      [at(350), at(1001)],
      [at(3600), undefined],
      [at(4000), at(5000)],
    ]
    for (const [from, to] of windows) {
      expect(counter.count(from, to), `window ${from}..${to}`).toBe(oldCount(root, from, to ?? Number.POSITIVE_INFINITY))
    }
  })

  it('on a tree that did not change, which is then not read again', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100) + '\n' + userLine(200) + '\n')
    expect(counter.count(BASE_MS)).toBe(2)
    expect(counter.bytesReadForTests()).toBeGreaterThan(0)
    const before = counter.bytesReadForTests()
    expect(counter.count(BASE_MS)).toBe(2)
    expect(counter.count(0)).toBe(2)
    expect(counter.bytesReadForTests()).toBe(before)
  })

  it('on an append of complete lines, which reads only the anchor check and the appended bytes', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100) + '\n')
    expect(counter.count(BASE_MS)).toBe(1)
    const consumed = statSync(file).size // how far the memo has consumed, and so its anchor length
    const add = userLine(200) + '\n' + userLine(300) + '\n'
    appendFileSync(file, add)
    const before = counter.bytesReadForTests()
    expect(counter.count(BASE_MS)).toBe(3)
    // the anchor re-check before the offset (at most ANCHOR_BYTES, 64) plus the append
    expect(counter.bytesReadForTests() - before).toBe(Math.min(64, consumed) + Buffer.byteLength(add))
    expect(counter.count(BASE_MS)).toBe(oldCount(root, BASE_MS))
  })

  it('on a line appended without its trailing newline: not counted until the newline arrives', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100) + '\n')
    expect(counter.count(BASE_MS)).toBe(1)
    appendFileSync(file, userLine(200)) // qualifies, but unfinished
    // the old counter already parsed it as a whole line; the incremental one must not
    expect(counter.count(BASE_MS)).toBe(1)
    appendFileSync(file, '\n')
    expect(counter.count(BASE_MS)).toBe(2)
    expect(counter.count(BASE_MS)).toBe(oldCount(root, BASE_MS))
  })

  it('on a file rewritten shorter (truncate + fewer lines), read whole again', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100) + '\n' + userLine(200) + '\n' + userLine(300) + '\n')
    expect(counter.count(BASE_MS)).toBe(3)
    truncateSync(file, 0)
    writeFileSync(file, userLine(150) + '\n')
    const before = counter.bytesReadForTests()
    expect(counter.count(BASE_MS)).toBe(1)
    expect(counter.bytesReadForTests() - before).toBe(statSync(file).size) // the whole new file, nothing more
    expect(counter.count(BASE_MS)).toBe(oldCount(root, BASE_MS))
  })

  it('on a file rewritten in place to a LARGER size (same inode), read whole again', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100) + '\n')
    const ino = statSync(file).ino
    const firstSize = statSync(file).size
    expect(counter.count(BASE_MS)).toBe(1)
    writeFileSync(file, userLine(400) + '\n' + userLine(500) + '\n') // truncated, then written larger
    expect(statSync(file).ino).toBe(ino) // same file, so only the anchor can give the rewrite away
    expect(statSync(file).size).toBeGreaterThan(firstSize)
    const before = counter.bytesReadForTests()
    expect(counter.count(at(300))).toBe(2)
    expect(counter.bytesReadForTests() - before).toBeGreaterThanOrEqual(statSync(file).size) // whole, not just past the offset
    expect(counter.count(at(300))).toBe(oldCount(root, at(300)))
  })

  it('on a file replaced by rename (a new inode, same name), read whole again', () => {
    const dir = project('proj')
    const file = join(dir, 's.jsonl')
    writeFileSync(file, userLine(100) + '\n')
    expect(counter.count(BASE_MS)).toBe(1)
    const spare = join(dir, 'replacement.jsonl.new')
    writeFileSync(spare, userLine(400) + '\n' + userLine(500) + '\n')
    renameSync(spare, file)
    const before = counter.bytesReadForTests()
    expect(counter.count(BASE_MS)).toBe(2)
    expect(counter.bytesReadForTests() - before).toBe(statSync(file).size) // the whole new file, nothing more
    expect(counter.count(BASE_MS)).toBe(oldCount(root, BASE_MS))
  })

  it('on a transcript whose mtime predates fromMs, skipped like before', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100) + '\n' + userLine(200) + '\n')
    const old = new Date(BASE_MS - 60_000)
    utimesSync(file, old, old)
    const before = counter.bytesReadForTests()
    expect(counter.count(BASE_MS)).toBe(0)
    expect(counter.bytesReadForTests() - before).toBe(0) // skipped before anything is read
    expect(counter.count(BASE_MS)).toBe(oldCount(root, BASE_MS))
    // the same tree still answers for a window that reaches it
    expect(counter.count(0)).toBe(oldCount(root, 0))
  })

  it('on a transcript untouched for longer than retainMs, forgotten once counted', () => {
    const dir = project('proj')
    const stale = join(dir, 'stale.jsonl')
    const fresh = join(dir, 'fresh.jsonl')
    writeFileSync(stale, userLine(100) + '\n')
    writeFileSync(fresh, userLine(200) + '\n')
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) // past the 49 h default
    utimesSync(stale, threeDaysAgo, threeDaysAgo)
    expect(counter.count(0)).toBe(oldCount(root, 0)) // a window that reaches both
    expect(counter.rememberedFilesForTests()).toBe(1) // only the fresh one is kept
    expect(counter.count(0)).toBe(oldCount(root, 0)) // the stale one is parsed whole again, same answer
  })

  it('on a transcript deleted from the tree, forgotten by the next count', () => {
    const dir = project('proj')
    const gone = join(dir, 'gone.jsonl')
    writeFileSync(gone, userLine(100) + '\n')
    writeFileSync(join(dir, 'staying.jsonl'), userLine(200) + '\n')
    expect(counter.count(0)).toBe(2)
    expect(counter.rememberedFilesForTests()).toBe(2)
    rmSync(gone)
    expect(counter.count(0)).toBe(1)
    expect(counter.rememberedFilesForTests()).toBe(1)
    expect(counter.count(0)).toBe(oldCount(root, 0))
  })

  it('on a missing root, counting 0', () => {
    expect(createUserTurnCounter(join(root, 'no-such-dir')).count(0)).toBe(0)
  })

  it('on a multibyte character split across the append boundary', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100, 'first full line ø 🎉') + '\n')
    expect(counter.count(BASE_MS)).toBe(1)
    const line = userLine(200, 'extended content: niño, façade, Straße 🎊 sign') + '\n'
    const bytes = Buffer.from(line, 'utf-8')
    const cut = Buffer.byteLength(line.slice(0, line.indexOf('ñ'))) + 1 // inside the 2-byte ñ
    expect(cut).toBeGreaterThan(0)
    expect(cut).toBeLessThan(bytes.length)
    appendFileSync(file, bytes.subarray(0, cut))
    expect(counter.count(BASE_MS)).toBe(1) // the halved line is not complete yet
    appendFileSync(file, bytes.subarray(cut))
    expect(counter.count(BASE_MS)).toBe(2)
    expect(counter.count(BASE_MS)).toBe(oldCount(root, BASE_MS))
  })

  // The one intended difference besides the unfinished last line: the old counter threw on a
  // line that parses to null and stopped counting that file; this one skips the line.
  it('on a line that parses to null: skipped, the rest still counted, nothing re-read', () => {
    const file = join(project('proj'), 's.jsonl')
    writeFileSync(file, userLine(100) + '\nnull\n' + userLine(200) + '\n')
    expect(counter.count(BASE_MS)).toBe(2)
    appendFileSync(file, 'null\n' + userLine(300) + '\n')
    expect(counter.count(BASE_MS)).toBe(3)
    const read = counter.bytesReadForTests()
    expect(counter.count(BASE_MS)).toBe(3)
    expect(counter.bytesReadForTests()).toBe(read)
  })

  it('on 150 random trees: appends, half-written lines, rewrites, renames, deletions, stale mtimes', () => {
    // An in-place rewrite to a LARGER size is caught by the anchor (the bytes just before
    // the remembered offset change) but only heuristically: a rewrite that happens to leave
    // those last bytes intact would still be read as an append, so the generator keeps to
    // shorter-or-equal rewrites and the deterministic test above covers the larger case. A
    // deleted path is likewise never reused: a recreated file can land on the deleted one's
    // inode number, which the memo would then take for the old file's identity.
    const windows: Array<[number, number | undefined]> = [
      [0, undefined], [BASE_MS, undefined], [at(1000), at(3000)], [at(2500), undefined],
    ]
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed)
      rmSync(root, { recursive: true, force: true }) // the beforeEach root: every seed gets its own
      root = mkdtempSync(join(tmpdir(), 'user-turns-'))
      // Every mtime below is derived from BASE_MS, a fixed date in the past, so no case
      // depends on when it runs -- which also puts them all past the default 49 h retention.
      // Retaining everything keeps the steps incremental, which is what this test is for.
      counter = createUserTurnCounter(root, { retainMs: Number.POSITIVE_INFINITY })
      let n = 0
      const dirs = Array.from({ length: 1 + r(3) }, () => project('p' + n++))
      const files: string[] = []
      for (const d of dirs) {
        for (let k = 0, kc = 1 + r(3); k < kc; k++) files.push(join(d, `s${n++}.jsonl`))
      }
      const size = new Map<string, number>()
      // every written file is stamped explicitly, each stamp further ahead than the last,
      // so the same path is never rewritten to the same size with the same mtime (which the
      // counter would answer from its memo). at(4000) sits above every window start below.
      let stamp = at(4000)
      const bump = (f: string): void => {
        stamp += 10_000
        const d = new Date(stamp)
        utimesSync(f, d, d)
      }
      const put = (f: string, text: string): void => {
        writeFileSync(f, text)
        size.set(f, Buffer.byteLength(text))
        bump(f)
      }
      const add = (f: string, text: string | Uint8Array): void => {
        appendFileSync(f, text)
        size.set(f, (size.get(f) ?? 0) + Buffer.byteLength(text))
        bump(f)
      }
      const parity = (where: string): void => {
        for (const [from, to] of windows) {
          expect(counter.count(from, to), `seed ${seed} ${where} window ${from}..${to}`)
            .toBe(oldCount(root, from, to ?? Number.POSITIVE_INFINITY))
        }
      }
      for (const f of files) put(f, Array.from({ length: r(5) }, () => randomLine(r)).join('\n') + '\n')
      parity('initial')
      for (let step = 0; step < 8 && files.length > 0; step++) {
        const f = files[r(files.length)]
        switch (r(6)) {
          case 0: case 1: { // complete lines appended
            add(f, Array.from({ length: 1 + r(4) }, () => randomLine(r)).join('\n') + '\n')
            break
          }
          case 2: { // a line written without its newline, maybe cut mid-character, then finished
            const bytes = Buffer.from(randomLine(r) + '\n', 'utf-8')
            const cut = r(bytes.length)
            add(f, bytes.subarray(0, cut))
            counter.count(0) // walks past the unfinished tail without consuming it
            add(f, bytes.subarray(cut))
            break
          }
          case 3: { // rewritten in place (same inode) shorter or to the same length
            const cur = size.get(f) ?? 0
            if (cur < 120) break
            const lines = Array.from({ length: 1 + r(3) }, () => randomLine(r))
            let text = lines.join('\n') + '\n'
            while (Buffer.byteLength(text) > cur && lines.length > 1) {
              lines.pop()
              text = lines.join('\n') + '\n'
            }
            if (Buffer.byteLength(text) > cur) break
            put(f, text)
            break
          }
          case 4: { // replaced by rename: a new inode under the same name
            const spare = f + '.new'
            const text = Array.from({ length: 1 + r(3) }, () => randomLine(r)).join('\n') + '\n'
            put(spare, text)
            renameSync(spare, f)
            size.set(f, Buffer.byteLength(text))
            break
          }
          default: { // a transcript deleted, a brand-new one, or a stale mtime
            if (r(3) === 0) {
              rmSync(f)
              files.splice(files.indexOf(f), 1)
              size.delete(f)
            } else if (r(4) === 0) {
              files.push(join(dirs[r(dirs.length)], `s${n++}.jsonl`))
              put(files[files.length - 1], randomLine(r) + '\n')
            } else {
              const stale = new Date(BASE_MS - (1 + r(3600)) * 1000)
              utimesSync(f, stale, stale) // older than most windows: skipped by both counters
            }
            break
          }
        }
        parity(`step ${step}`)
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
