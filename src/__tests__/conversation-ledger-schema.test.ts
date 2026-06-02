import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The conversation-continuity ledger schema is defined in TWO places: the db.ts
// migration (canonical, run by the dashboard) and ledger_lib.py (defensive, so a
// hook that runs before the dashboard migration still works). They MUST stay
// identical -- a drift would mean a hook writing a column the migration doesn't
// have, or vice versa. This test locks them together.
const ROOT = join(__dirname, '..', '..')

function pendingColumns(src: string): string[] {
  const m = src.match(/CREATE TABLE IF NOT EXISTS pending_messages\s*\(([\s\S]*?)\n\s*\)/)
  if (!m) return []
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(UNIQUE|PRIMARY|FOREIGN|CHECK)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean)
}

describe('pending_messages schema: db.ts migration == ledger_lib.py (no drift)', () => {
  const dbts = readFileSync(join(ROOT, 'src/db.ts'), 'utf-8')
  const lib = readFileSync(join(ROOT, 'scripts/hooks/ledger_lib.py'), 'utf-8')

  it('both places define the table', () => {
    expect(dbts).toMatch(/CREATE TABLE IF NOT EXISTS pending_messages/)
    expect(lib).toMatch(/CREATE TABLE IF NOT EXISTS pending_messages/)
  })

  it('the column sets are identical and complete', () => {
    const a = pendingColumns(dbts).sort()
    const b = pendingColumns(lib).sort()
    expect(a).toEqual(['answered', 'answered_at', 'chat_id', 'created_at', 'message_id', 'text', 'ts'])
    expect(b).toEqual(a)
  })

  it('both enforce capture idempotency via UNIQUE(chat_id, message_id)', () => {
    expect(dbts).toMatch(/UNIQUE\(chat_id,\s*message_id\)/)
    expect(lib).toMatch(/UNIQUE\(chat_id,\s*message_id\)/)
  })

  it('db.ts creates the unanswered lookup index', () => {
    expect(dbts).toMatch(/CREATE INDEX IF NOT EXISTS idx_pending_unanswered ON pending_messages\(chat_id, answered\)/)
  })
})
