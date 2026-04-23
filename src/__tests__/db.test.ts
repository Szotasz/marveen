import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  initDatabase,
  getSession,
  setSession,
  clearSession,
  saveMemory,
  recentMemories,
  decayMemories,
  getMemoriesForChat,
  buildFtsMatchExpression,
  getDb,
  upsertPendingTaskRetry,
  insertPendingTaskRetryIfNew,
  updatePendingTaskRetry,
  listPendingTaskRetries,
  getPendingTaskRetry,
  deletePendingTaskRetry,
  deletePendingTaskRetryById,
  markPendingTaskRetryAlert,
  clearPendingTaskRetryAlert,
} from '../db.js'

beforeAll(() => {
  // Teszt adatbázis inicializálás
  process.env.NODE_ENV = 'test'
  initDatabase()
})

describe('sessions', () => {
  it('munkamenetet ment es visszaolvas', () => {
    setSession('test-chat-1', 'session-abc')
    const s = getSession('test-chat-1')
    expect(s?.sessionId).toBe('session-abc')
    expect(s?.messageCount).toBe(0)
  })

  it('munkamenetet felulir', () => {
    setSession('test-chat-2', 'old-session')
    setSession('test-chat-2', 'new-session')
    expect(getSession('test-chat-2')?.sessionId).toBe('new-session')
  })

  it('munkamenetet torol', () => {
    setSession('test-chat-3', 'session-xyz')
    clearSession('test-chat-3')
    expect(getSession('test-chat-3')).toBeUndefined()
  })

  it('undefined ad vissza ha nem letezik', () => {
    expect(getSession('nem-letezik')).toBeUndefined()
  })
})

describe('memories', () => {
  it('emlek mentest es lekerdezest vegez', () => {
    saveMemory('mem-chat-1', 'Szeretem a kavét', 'semantic')
    const mems = recentMemories('mem-chat-1', 5)
    expect(mems.length).toBeGreaterThan(0)
    expect(mems[0].content).toBe('Szeretem a kavét')
    expect(mems[0].sector).toBe('semantic')
  })

  it('epizodikus emleket ment', () => {
    saveMemory('mem-chat-2', 'Mai megbeszeles eredmenye', 'episodic')
    const mems = getMemoriesForChat('mem-chat-2')
    expect(mems.length).toBeGreaterThan(0)
    expect(mems[0].sector).toBe('episodic')
  })

  it('leepulesi soprest vegrehajt hiba nelkul', () => {
    expect(() => decayMemories()).not.toThrow()
  })
})

describe('buildFtsMatchExpression', () => {
  it('produces prefix-matched tokens for a plain query', () => {
    expect(buildFtsMatchExpression('hello world')).toBe('hello* world*')
  })

  it('returns empty string for whitespace-only or empty input', () => {
    expect(buildFtsMatchExpression('')).toBe('')
    expect(buildFtsMatchExpression('   ')).toBe('')
    expect(buildFtsMatchExpression('!!!***???')).toBe('')
  })

  it('lowercases to neutralize FTS5 AND/OR/NOT/NEAR operators', () => {
    const out = buildFtsMatchExpression('foo OR bar AND baz NOT qux')
    // No uppercase operator keywords should survive as standalone tokens.
    expect(out).not.toMatch(/\bOR\b/)
    expect(out).not.toMatch(/\bAND\b/)
    expect(out).not.toMatch(/\bNOT\b/)
    expect(out).toBe('foo* or* bar* and* baz* not* qux*')
  })

  it('strips FTS5 punctuation (quotes, parens, colons); * is ours', () => {
    const out = buildFtsMatchExpression('"foo" (bar) baz qux:zap')
    expect(out).not.toMatch(/["():]/)
    // Every * in the output is our own prefix-match suffix, appended to a token.
    // No bare *, no doubled **.
    expect(out).not.toMatch(/\*\*/)
    expect(out).not.toMatch(/(^| )\*/)
    expect(out).toBe('foo* bar* baz* quxzap*')
  })

  it('caps at 20 tokens', () => {
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const out = buildFtsMatchExpression(many)
    expect(out.split(' ').length).toBe(20)
  })

  it('truncates individual tokens longer than 64 chars', () => {
    const long = 'a'.repeat(200)
    const out = buildFtsMatchExpression(long)
    // 64 'a's + '*'
    expect(out).toBe('a'.repeat(64) + '*')
  })

  it('preserves unicode letters and digits', () => {
    expect(buildFtsMatchExpression('Árvíztűrő 42')).toBe('árvíztűrő* 42*')
  })
})

describe('pending task retries', () => {
  // The persistent test DB is shared with the running dashboard (both
  // resolve STORE_DIR to the same absolute path), so a blanket DELETE
  // would wipe the operator's real pending retries. Scope the cleanup to
  // the exact fixture names used below, and run it both before and after
  // so a re-run cleans up after itself even if an assertion throws.
  const FIXTURE_NAMES = [
    'task-a', 'task-b', 'task-c', 'task-d', 'task-e', 'task-f',
    'task-old', 'task-new', 'task-new-only', 'task-upd-only',
    'task-clear-alert',
  ]
  const wipeFixtures = () => {
    const stmt = getDb().prepare('DELETE FROM pending_task_retries WHERE task_name = ?')
    for (const n of FIXTURE_NAMES) stmt.run(n)
  }
  beforeAll(wipeFixtures)
  afterAll(wipeFixtures)

  it('inserts a new row on first upsert', () => {
    upsertPendingTaskRetry('task-a', 'main', 1_000_000, 'busy')
    const row = getPendingTaskRetry('task-a', 'main')
    expect(row).toMatchObject({
      task_name: 'task-a',
      agent_name: 'main',
      first_attempt: 1_000_000,
      last_attempt: 1_000_000,
      attempt_count: 1,
      last_reason: 'busy',
      alert_sent_at: null,
    })
  })

  it('bumps attempt_count and last_attempt on subsequent upserts, preserves first_attempt', () => {
    upsertPendingTaskRetry('task-b', 'main', 2_000_000, 'busy')
    upsertPendingTaskRetry('task-b', 'main', 2_000_500, 'busy')
    upsertPendingTaskRetry('task-b', 'main', 2_001_000, 'busy')
    const row = getPendingTaskRetry('task-b', 'main')!
    expect(row.first_attempt).toBe(2_000_000)
    expect(row.last_attempt).toBe(2_001_000)
    expect(row.attempt_count).toBe(3)
  })

  it('lists entries ordered by first_attempt ASC', () => {
    upsertPendingTaskRetry('task-old', 'main', 3_000_000, 'busy')
    upsertPendingTaskRetry('task-new', 'main', 4_000_000, 'busy')
    const rows = listPendingTaskRetries().filter(r => ['task-old', 'task-new'].includes(r.task_name))
    expect(rows[0].task_name).toBe('task-old')
    expect(rows[1].task_name).toBe('task-new')
  })

  it('deletes by (name, agent) returning true; false when absent', () => {
    upsertPendingTaskRetry('task-c', 'main', 5_000_000, 'busy')
    expect(deletePendingTaskRetry('task-c', 'main')).toBe(true)
    expect(deletePendingTaskRetry('task-c', 'main')).toBe(false)
  })

  it('deletes by id returning true; false when absent', () => {
    upsertPendingTaskRetry('task-d', 'main', 6_000_000, 'busy')
    const row = getPendingTaskRetry('task-d', 'main')!
    expect(deletePendingTaskRetryById(row.id)).toBe(true)
    expect(deletePendingTaskRetryById(row.id)).toBe(false)
  })

  it('markAlert sets alert_sent_at only once (subsequent calls no-op)', () => {
    upsertPendingTaskRetry('task-e', 'main', 7_000_000, 'busy')
    expect(markPendingTaskRetryAlert('task-e', 'main', 7_000_100)).toBe(true)
    expect(markPendingTaskRetryAlert('task-e', 'main', 7_000_200)).toBe(false)
    const row = getPendingTaskRetry('task-e', 'main')!
    expect(row.alert_sent_at).toBe(7_000_100)
  })

  it('separate (name, agent) pairs are distinct rows', () => {
    upsertPendingTaskRetry('task-f', 'agent-1', 8_000_000, 'busy')
    upsertPendingTaskRetry('task-f', 'agent-2', 8_000_000, 'busy')
    const rows = listPendingTaskRetries().filter(r => r.task_name === 'task-f')
    expect(rows).toHaveLength(2)
  })

  it('insertPendingTaskRetryIfNew inserts once then refuses', () => {
    expect(insertPendingTaskRetryIfNew('task-new-only', 'main', 9_000_000, 'busy')).toBe(true)
    expect(insertPendingTaskRetryIfNew('task-new-only', 'main', 9_000_100, 'busy')).toBe(false)
    const row = getPendingTaskRetry('task-new-only', 'main')!
    // first_attempt stays at the original (9_000_000), not the second call
    expect(row.first_attempt).toBe(9_000_000)
    expect(row.attempt_count).toBe(1)
  })

  it('updatePendingTaskRetry only mutates existing rows (no insert)', () => {
    // No row yet -> returns false, no row created
    expect(updatePendingTaskRetry('task-upd-only', 'main', 10_000_000, 'busy')).toBe(false)
    expect(getPendingTaskRetry('task-upd-only', 'main')).toBeUndefined()

    // After insert, update bumps attempt_count + last_attempt
    insertPendingTaskRetryIfNew('task-upd-only', 'main', 10_000_000, 'busy')
    expect(updatePendingTaskRetry('task-upd-only', 'main', 10_000_500, 'error')).toBe(true)
    const row = getPendingTaskRetry('task-upd-only', 'main')!
    expect(row.last_attempt).toBe(10_000_500)
    expect(row.attempt_count).toBe(2)
    expect(row.last_reason).toBe('error')
  })

  it('clearPendingTaskRetryAlert resets alert_sent_at so the next tick can retry', () => {
    insertPendingTaskRetryIfNew('task-clear-alert', 'main', 11_000_000, 'busy')
    markPendingTaskRetryAlert('task-clear-alert', 'main', 11_000_100)
    expect(getPendingTaskRetry('task-clear-alert', 'main')!.alert_sent_at).toBe(11_000_100)

    expect(clearPendingTaskRetryAlert('task-clear-alert', 'main')).toBe(true)
    expect(getPendingTaskRetry('task-clear-alert', 'main')!.alert_sent_at).toBeNull()

    // After clear, markAlert succeeds again
    expect(markPendingTaskRetryAlert('task-clear-alert', 'main', 11_000_200)).toBe(true)
  })
})
