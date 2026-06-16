import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase, logConfigChange, getRecentConfigChanges } from '../db.js'

// In-memory DB, never touches the real store/claudeclaw.db (same pattern as
// db.test.ts) -- this table only matters as a background audit trail, no UI
// reads it yet.
beforeAll(() => {
  initDatabase(':memory:')
})

describe('config change log', () => {
  it('records an old -> new change with the actor and can read it back newest-first', () => {
    logConfigChange('KANBAN_WIP_WARN_PCT', 80, 42, 'dashboard')
    logConfigChange('KANBAN_WIP_OK_COLOR', '#6b7280', '#112233', 'dashboard')

    const rows = getRecentConfigChanges(10)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0].key).toBe('KANBAN_WIP_OK_COLOR')
    expect(rows[0].old_value).toBe('#6b7280')
    expect(rows[0].new_value).toBe('#112233')
    expect(rows[0].actor).toBe('dashboard')
  })

  it('stores null old/new values as null (for a future secret entry), never a string "null"', () => {
    logConfigChange('SOME_FUTURE_SECRET', null, null, 'dashboard')
    const rows = getRecentConfigChanges(1)
    expect(rows[0].old_value).toBeNull()
    expect(rows[0].new_value).toBeNull()
  })
})
