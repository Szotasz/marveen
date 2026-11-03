// #2428: the Log page's diary source listed every daily-log entry twice, once as the
// log row and once as its `[Napló ...]` mirror memory (linked in daily_log_memory).
// The diary branch of queryAuditLog() now leaves the mirror out, the way recall does.
// Real memories and log rows without a mirror are listed as before.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { appendDailyLog, getDb, initDatabase, queryAuditLog, saveAgentMemory } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const diary = (opts: Partial<Parameters<typeof queryAuditLog>[0]> = {}) => queryAuditLog({ sources: ['diary'], limit: 50, ...opts })

describe('queryAuditLog diary source and the daily-log mirror', () => {
  it('a mirrored log entry is listed once, as the log row', () => {
    const { id, memoryId } = appendDailyLog('geri', '## 21:00 -- probe entry', { mirror: true })
    expect(memoryId).not.toBeNull()
    // the mirror really exists and is linked: the precondition the old query tripped on
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM daily_log_memory WHERE memory_id = ?').get(memoryId)).toEqual({ n: 1 })
    const rows = diary()
    expect(rows.map((r) => [r.entry_type, r.id])).toEqual([['log', id]])
  })

  it('a real memory next to it is still listed', () => {
    const { id } = appendDailyLog('geri', 'log line', { mirror: true })
    const mem = saveAgentMemory('geri', 'a real warm memory', 'warm', 'k')
    const rows = diary()
    expect(rows.filter((r) => r.entry_type === 'log').map((r) => r.id)).toEqual([id])
    expect(rows.filter((r) => r.entry_type === 'memory').map((r) => r.id)).toEqual([mem.id])
  })

  it('a log row without a mirror (e.g. refused by the content filter) is listed', () => {
    const { id, memoryId } = appendDailyLog('geri', 'no mirror here')
    expect(memoryId).toBeNull()
    expect(diary().map((r) => [r.entry_type, r.id])).toEqual([['log', id]])
  })

  it('the agent and text filters keep the mirror out too', () => {
    appendDailyLog('geri', 'needle in the log', { mirror: true })
    appendDailyLog('samu', 'other agent', { mirror: true })
    expect(diary({ agent: 'geri' }).map((r) => r.entry_type)).toEqual(['log'])
    expect(diary({ q: 'needle' }).map((r) => r.entry_type)).toEqual(['log'])
  })

  it('the mirror stays reachable outside the Log page: it is still a memories row', () => {
    const { memoryId } = appendDailyLog('geri', 'searchable', { mirror: true })
    const row = getDb().prepare('SELECT content FROM memories WHERE id = ?').get(memoryId) as { content: string }
    expect(row.content).toMatch(/^\[Napló /)
  })
})
