// BACKLOGTZ1109: the reconnect-backlog summary quotes each message's time in the
// install zone, not in unmarked UTC.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatBacklogTimestamp } from '../web/backlog-timestamp.js'

// 2026-09-17 16:49:54 UTC
const T = Date.UTC(2026, 8, 17, 16, 49, 54) / 1000

describe('formatBacklogTimestamp (BACKLOGTZ1109)', () => {
  it('renders the wall clock of the given zone, summer and winter', () => {
    expect(formatBacklogTimestamp(T, 'Europe/Budapest')).toBe('2026-09-17 18:49:54')
    expect(formatBacklogTimestamp(T, 'America/New_York')).toBe('2026-09-17 12:49:54')
    expect(formatBacklogTimestamp(T, 'UTC')).toBe('2026-09-17 16:49:54')
    const winter = Date.UTC(2026, 0, 5, 23, 30, 0) / 1000
    expect(formatBacklogTimestamp(winter, 'Europe/Budapest')).toBe('2026-01-06 00:30:00')
  })

  it('keeps the old line shape (YYYY-MM-DD HH:MM:SS), only the zone changes', () => {
    expect(formatBacklogTimestamp(T, 'Asia/Tokyo')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('the router uses it with the install zone, and no longer formats via toISOString', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'message-router.ts'), 'utf-8')
    expect(src).toContain('formatBacklogTimestamp(m.created_at, APP_TZ)')
    expect(src).not.toMatch(/toISOString\(\)\.replace\('T', ' '\)/)
  })
})
