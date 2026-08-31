/**
 * Verifies INSERT OR IGNORE semantics of seedScheduleIfAbsent:
 * re-seeding must NOT overwrite a row that was hand-edited in the DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDb, seedScheduleIfAbsent, getScheduleFromDb } from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  getDb().exec("DELETE FROM schedules WHERE id LIKE 'test-seed-%'")
})

describe('seedScheduleIfAbsent INSERT OR IGNORE', () => {
  const id = 'test-seed-noklobber'

  const baseOpts = {
    prompt: 'original prompt',
    description: 'original description',
    schedule: '0 9 * * *',
    agent: 'jarvis',
    type: 'task' as const,
    enabled: true,
    tenant_id: null,
    skip_if_busy: false,
    force_send: false,
    target_session: null,
    command: null,
    timeout_ms: null,
    fail_threshold: null,
    pre_check: null,
    catch_up_max_age_minutes: null,
    stuck_after_minutes: null,
    requires: null,
  }

  it('inserts the row on first call and returns true', () => {
    const inserted = seedScheduleIfAbsent(id, baseOpts)
    expect(inserted).toBe(true)
    const row = getScheduleFromDb(id)
    expect(row).not.toBeNull()
    expect(row!.prompt).toBe('original prompt')
  })

  it('second call with different data returns false (no insert)', () => {
    const inserted = seedScheduleIfAbsent(id, { ...baseOpts, prompt: 'overwrite attempt' })
    expect(inserted).toBe(false)
  })

  it('row still contains original data after second call', () => {
    const row = getScheduleFromDb(id)
    expect(row).not.toBeNull()
    expect(row!.prompt).toBe('original prompt')
    expect(row!.description).toBe('original description')
  })
})
