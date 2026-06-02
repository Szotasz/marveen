import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The conversation-continuity ledger schema is defined in TWO places: the db.ts
// migration (canonical, run by the dashboard) and ledger_lib.py (defensive, so a
// hook that runs before the dashboard migration still works). They MUST stay
// identical -- a drift would mean a hook writing a column the migration doesn't
// have, or vice versa. This test locks them together.
const ROOT = join(__dirname, '..', '..')

function logColumns(src: string): string[] {
  const m = src.match(/CREATE TABLE IF NOT EXISTS conversation_log\s*\(([\s\S]*?)\n\s*\)/)
  if (!m) return []
  return m[1]
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l && !/^(UNIQUE|PRIMARY|FOREIGN|CHECK)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0])
    .filter(Boolean)
}

describe('conversation_log schema: db.ts migration == ledger_lib.py (no drift)', () => {
  const dbts = readFileSync(join(ROOT, 'src/db.ts'), 'utf-8')
  const lib = readFileSync(join(ROOT, 'scripts/hooks/ledger_lib.py'), 'utf-8')

  it('both places define the table', () => {
    expect(dbts).toMatch(/CREATE TABLE IF NOT EXISTS conversation_log/)
    expect(lib).toMatch(/CREATE TABLE IF NOT EXISTS conversation_log/)
  })

  it('the column sets are identical and complete', () => {
    const a = logColumns(dbts).sort()
    const b = logColumns(lib).sort()
    expect(a).toEqual(['agent_id', 'chat_id', 'created_at', 'direction', 'id', 'message_id', 'text', 'ts'])
    expect(b).toEqual(a)
  })

  it('both constrain direction to in/out', () => {
    expect(dbts).toMatch(/direction\s+TEXT\s+NOT NULL\s+CHECK\(direction IN \('in','out'\)\)/)
    expect(lib).toMatch(/direction\s+TEXT\s+NOT NULL\s+CHECK\(direction IN \('in','out'\)\)/)
  })

  it('both dedupe inbound capture via UNIQUE(agent_id, chat_id, direction, message_id)', () => {
    expect(dbts).toMatch(/UNIQUE\(agent_id,\s*chat_id,\s*direction,\s*message_id\)/)
    expect(lib).toMatch(/UNIQUE\(agent_id,\s*chat_id,\s*direction,\s*message_id\)/)
  })

  it('db.ts creates the per-agent lookup index', () => {
    expect(dbts).toMatch(/CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log\(agent_id, created_at\)/)
  })
})
