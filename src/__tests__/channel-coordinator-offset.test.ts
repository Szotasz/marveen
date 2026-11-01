import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../channel-coordinator/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-coordinator/ingest.js')>()
  return {
    ...actual,
    insertIncomingEvent: vi.fn(actual.insertIncomingEvent),
    createHandoffMessage: vi.fn(actual.createHandoffMessage),
  }
})

import { processBatch } from '../channel-coordinator.js'
import { mapUpdate } from '../channel-coordinator/telegram-client.js'
import * as ingest from '../channel-coordinator/ingest.js'

const SOURCE = 'telegram'
const upd = (id: number) => ({
  update_id: id,
  message: { message_id: id, date: 1700000000, text: `m${id}`, chat: { id: 42, type: 'private' }, from: { id: 42 } },
})
const asBatch = (...ids: number[]) => ids.map(upd)

let db: ReturnType<typeof ingest.initIngestDb>
const failStore = (ids: Set<number>) => {
  const actual = vi.mocked(ingest.insertIncomingEvent)
  actual.mockImplementation(((source: string, ev: { update_id: number }) => {
    if (ids.has(ev.update_id)) throw new Error('db down')
    return realInsert(source, ev as never)
  }) as never)
}
let realInsert: typeof ingest.insertIncomingEvent
let realHandoff: typeof ingest.createHandoffMessage

// Re-inserting via the real function: inserted=false means it was already stored.
const probe = (id: number) => realInsert(SOURCE, mapUpdate(upd(id))!).inserted
const messageCount = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../channel-coordinator/ingest.js')>('../channel-coordinator/ingest.js')
  realInsert = actual.insertIncomingEvent
  realHandoff = actual.createHandoffMessage
  db = ingest.initIngestDb(':memory:')
  vi.mocked(ingest.insertIncomingEvent).mockImplementation(realInsert as never)
  vi.mocked(ingest.createHandoffMessage).mockImplementation(realHandoff as never)
})

afterEach(() => {
  ingest.closeIngestDb()
})

describe('processBatch offset', () => {
  it('T1 no failure advances to the last update and stores all', () => {
    expect(processBatch(asBatch(10, 11, 12))).toEqual({ offset: 12, stalled: false })
    expect(probe(10)).toBe(false)
    expect(probe(11)).toBe(false)
    expect(probe(12)).toBe(false)
  })

  it('T2 store failure stops the batch before the failed update', () => {
    failStore(new Set([11]))
    expect(processBatch(asBatch(10, 11, 12))).toEqual({ offset: 10, stalled: true })
    expect(probe(10)).toBe(false)
    expect(probe(11)).toBe(true)
    expect(probe(12)).toBe(true)
  })

  it('T3 failure on the first update gives a null offset', () => {
    failStore(new Set([10]))
    expect(processBatch(asBatch(10, 11))).toEqual({ offset: null, stalled: true })
    expect(probe(10)).toBe(true)
    expect(probe(11)).toBe(true)
  })

  it('T4 redelivery after a failure hands over each update once', () => {
    failStore(new Set([11]))
    expect(processBatch(asBatch(10, 11, 12))).toEqual({ offset: 10, stalled: true })
    vi.mocked(ingest.insertIncomingEvent).mockImplementation(realInsert as never)
    // The redelivered batch overlaps the update that was already stored, so the
    // dedup path (inserted:false) runs for 10 and must not hand it over again.
    expect(processBatch(asBatch(10, 11, 12))).toEqual({ offset: 12, stalled: false })
    expect(messageCount()).toBe(3)
    // A second identical redelivery changes nothing.
    expect(processBatch(asBatch(10, 11, 12))).toEqual({ offset: 12, stalled: false })
    expect(messageCount()).toBe(3)
  })

  it('T4b an unhandled kind before a failure is covered by the offset', () => {
    const ignored = { update_id: 11 }
    expect(mapUpdate(ignored as never)).toBeNull()
    failStore(new Set([12]))
    expect(processBatch([upd(10), ignored, upd(12)])).toEqual({ offset: 11, stalled: true })
  })

  it('T5 an unhandled update kind still advances', () => {
    // Last in the batch, so no later stored update can carry the offset past it.
    const ignored = { update_id: 11 }
    expect(mapUpdate(ignored as never)).toBeNull()
    expect(processBatch([upd(10), ignored])).toEqual({ offset: 11, stalled: false })
  })

  it('T6 a failing handoff does not stop the batch', () => {
    let n = 0
    vi.mocked(ingest.createHandoffMessage).mockImplementation((c: string) => {
      if (++n === 2) throw new Error('handoff down')
      return realHandoff(c)
    })
    expect(processBatch(asBatch(10, 11, 12))).toEqual({ offset: 12, stalled: false })
    expect(probe(11)).toBe(false)
  })
})

// runLoop is not exported and drives real network + process probes, so its
// offset bookkeeping cannot be exercised through the public surface. Instead we
// pin the call site in the source text: slice the runLoop body out of the
// module and assert exactly which values it hands to setOffset. If someone
// swaps the batch offset for the batch's highest update_id (which skips the
// updates the store failed to keep, so Telegram never redelivers them), these
// tests go red.
describe('runLoop persists only the offset processBatch returns (source pin)', () => {
  // The coordinator module under pin, resolved next to this test file.
  const sourceUrl = new URL('../channel-coordinator.ts', import.meta.url)

  const countOccurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1

  // Cut every line comment (from "//" to the end of the line). The runLoop body
  // holds no "//" inside string or regex literals, so a plain cut is exact here.
  const stripLineComments = (text: string): string =>
    text
      .split('\n')
      .map((line) => {
        const cut = line.indexOf('//')
        return cut === -1 ? line : line.slice(0, cut)
      })
      .join('\n')

  // Collapse every run of whitespace (including newlines) to one space.
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

  // The runLoop body: from its declaration line up to (not including) the
  // bootstrap banner that follows it. Both anchors must be unambiguous.
  function runLoopBody(src: string): string {
    const anchors = ['async function runLoop(', '// ---- bootstrap']
    for (const anchor of anchors) {
      if (countOccurrences(src, anchor) !== 1) {
        throw new Error(`anchor must occur exactly once in src, got ${countOccurrences(src, anchor)}: "${anchor}"`)
      }
    }
    const lines = src.split('\n')
    const start = lines.findIndex((line) => line.includes('async function runLoop('))
    const end = lines.findIndex((line) => line.includes('// ---- bootstrap'))
    return lines.slice(start, end).join('\n')
  }

  // Argument text of every setOffset(...) call in body, comments stripped,
  // nested parentheses matched, whitespace collapsed. Order is source order.
  function setOffsetArgs(body: string): string[] {
    const stripped = stripLineComments(body)
    const args: string[] = []
    let at = stripped.indexOf('setOffset(')
    while (at !== -1) {
      const open = at + 'setOffset('.length - 1
      let depth = 0
      let close = -1
      for (let i = open; i < stripped.length; i++) {
        const ch = stripped[i]
        if (ch === '(') depth++
        else if (ch === ')') {
          depth--
          if (depth === 0) { close = i; break }
        }
      }
      if (close === -1) throw new Error('setOffset( call with unbalanced parentheses')
      args.push(collapse(stripped.slice(open + 1, close)))
      at = stripped.indexOf('setOffset(', close)
    }
    return args
  }

  // The pinned shape: processBatch is destructured exactly once, and the first
  // non-blank line after it persists exactly the returned offset, nothing else.
  function batchOffsetComesStraightFromProcessBatch(body: string): boolean {
    const stripped = stripLineComments(body)
    const call = 'const { offset, stalled } = processBatch(updates)'
    if (countOccurrences(collapse(stripped), call) !== 1) return false
    const lines = stripped.split('\n').map(collapse)
    const callIdx = lines.findIndex((line) => line.includes(call))
    for (const next of lines.slice(callIdx + 1)) {
      if (next === '') continue // a line that was only a comment
      return next === 'if (offset != null) setOffset(SOURCE, offset)'
    }
    return false
  }

  it('the run loop writes the offset only through the two known calls', () => {
    const src = readFileSync(fileURLToPath(sourceUrl), 'utf-8')
    // The high-water seed on entering backfill, then the batch offset. Any
    // third call, or a different value in either, fails this pin.
    expect(setOffsetArgs(runLoopBody(src))).toEqual(['SOURCE, hw', 'SOURCE, offset'])
  })

  it('the batch offset comes straight from processBatch', () => {
    const src = readFileSync(fileURLToPath(sourceUrl), 'utf-8')
    expect(batchOffsetComesStraightFromProcessBatch(runLoopBody(src))).toBe(true)
  })

  it('the pin goes red on the highest-id mutant', () => {
    const src = readFileSync(fileURLToPath(sourceUrl), 'utf-8')
    const mutated = runLoopBody(src).replace(
      'setOffset(SOURCE, offset)',
      'setOffset(SOURCE, Math.max(...updates.map(u => u.update_id)))',
    )
    expect(mutated).not.toBe(runLoopBody(src)) // the mutant must actually differ
    expect(setOffsetArgs(mutated)).not.toEqual(['SOURCE, hw', 'SOURCE, offset'])
    expect(batchOffsetComesStraightFromProcessBatch(mutated)).toBe(false)
  })
})
