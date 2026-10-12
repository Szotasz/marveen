import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `unixepoch()` is SQLite 3.38+. Node's better-sqlite3 bundles a recent SQLite,
// so anything we run through it works -- and that is exactly why this broke
// quietly: the SAME schema is also written by the system `python3` (and by the
// `sqlite3` CLI) on hosts where libsqlite3 is older. Ubuntu 22.04 LTS ships
// 3.37.2 and its repositories offer nothing newer, so on those boxes every
// Python-side write that touches one of these objects died with
// `no such function: unixepoch` while the dashboard kept working.
//
// The distinction that matters is WHOSE connection evaluates the expression:
//
//   - a TRIGGER body and a column DEFAULT run on the connection doing the
//     INSERT/UPDATE -> a Python writer evaluates them, so they must be portable;
//   - a statement we prepare ourselves (e.g. HEARTBEAT_NEW_HOT_MEMORIES_SQL)
//     only ever runs on our own connection -> `unixepoch()` is fine there and is
//     deliberately left alone.
//
// Measured on 2026-09-21 against a copy of the live DB with python sqlite3
// 3.37.2: the old form raised `no such function: unixepoch`, the replacement
// `CAST(strftime('%s','now') AS INTEGER)` returned the same integer value and
// the triggers fired (memories.updated_at stamped, homoglyph_findings row
// inserted). `strftime` has been in SQLite since long before 3.37; the CAST
// keeps the column INTEGER, so stored values are identical to what
// unixepoch() wrote.
const SRC = readFileSync(join(__dirname, '..', 'db.ts'), 'utf8')

// A trigger body is always inside a db.exec(`...`) template literal here, so
// slice on the literal rather than on a "up to the first END" regex: a CASE
// expression inside a body ends with END too, and a naive non-greedy match
// silently swallowed the NEXT trigger definition. (Caught by the control test
// below before this file shipped, which is the whole point of having one.)
function triggerBodies(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = []
  const re = /db\.exec\(`([\s\S]*?)`\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const body = m[1]
    const name = /CREATE TRIGGER(?:\s+IF NOT EXISTS)?\s+(\w+)/i.exec(body)
    if (name) out.push({ name: name[1], body })
  }
  return out
}

describe('db.ts: no unixepoch() on a path a foreign writer evaluates', () => {
  it('finds trigger definitions at all -- the control that makes the assertions below mean something', () => {
    const bodies = triggerBodies(SRC)
    expect(bodies.length).toBeGreaterThan(5)
    expect(bodies.map(b => b.name)).toContain('memories_touch')
  })

  it('has no unixepoch() inside any TRIGGER body', () => {
    const offenders = triggerBodies(SRC).filter(b => /unixepoch\s*\(/i.test(b.body)).map(b => b.name)
    expect(offenders, `portable form: CAST(strftime('%s','now') AS INTEGER)`).toEqual([])
  })

  it('has no unixepoch() inside a column DEFAULT', () => {
    const defaults = SRC.match(/DEFAULT\s*\([^)]*\)/gi) ?? []
    expect(defaults.filter(d => /unixepoch/i.test(d))).toEqual([])
  })

  it('uses the portable replacement, and re-creates the changed triggers instead of relying on IF NOT EXISTS', () => {
    // A bare `CREATE TRIGGER IF NOT EXISTS` is a no-op against an already
    // installed older body, so an upgraded install would silently keep the
    // broken trigger. Every trigger whose body we changed gets an explicit DROP.
    expect(SRC).toContain(`CAST(strftime('%s','now') AS INTEGER)`)
    for (const name of ['memories_touch', 'homoglyph_kanban_comments_ai', 'homoglyph_kanban_cards_ai']) {
      expect(SRC, `${name} needs a DROP before its CREATE`).toContain(`DROP TRIGGER IF EXISTS ${name}`)
    }
  })
})
