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
