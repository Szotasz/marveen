import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, getDbFileSizeMb } from '../db.js'
import { buildHeartbeatSummaryResponse } from '../web/routes/kanban.js'

// HBDBMERET822: the heartbeat's "DB size" line had NO sanctioned source --
// the scaffold template said `- DB size: <X> MB` and every session re-invented
// the measurement. Measured drift on 2026-08-22: 09:00 `157 MB`, 14:00 `160M`
// (du -h shape, different session), 15:00 `0.0 MB` against a real 159 MB.
// Same family as HBMEMBLIND807/819 and the planned-count fix: a prescription
// the measured party must re-apply every round is not a mechanism; a number
// computed server-side has nothing to rewrite. These tests pin three halves:
// the server-side function measures the OPENED database honestly (null, never
// 0, when it cannot), the endpoint serves it under counts.*, and the scaffold
// tells the agent to copy the field and forbids self-measurement.

const ROOT = join(__dirname, '..', '..')

describe('getDbFileSizeMb (server-side, against the OPENED database)', () => {
  it('reports the real on-disk size of the database it opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-dbsize-'))
    const dbPath = join(dir, 'test.db')
    initDatabase(dbPath)
    const reported = getDbFileSizeMb()
    const real = statSync(dbPath).size / (1024 * 1024)
    expect(reported).not.toBeNull()
    // A freshly-initialized schema is small but NOT empty -- the honest value
    // is the stat of the same file, to one decimal.
    expect(reported).toBe(Math.round(real * 10) / 10)
  })

  it(':memory: has no file: null, never a fabricated 0', () => {
    initDatabase(':memory:')
    expect(getDbFileSizeMb()).toBeNull()
  })
})

describe('the endpoint serves the number under counts.* (truncation-safe surface)', () => {
  const empty = { urgent: [], in_progress: [], waiting: [] }

  it('db_size_mb rides in counts, inside the first 200 bytes', () => {
    const json = JSON.stringify(buildHeartbeatSummaryResponse(empty, 0, 0, 159.7))
    expect(json.slice(0, 200)).toContain('"db_size_mb":159.7')
  })

  it('null passes through as null -- the builder must not coerce "unknown" into a calm-looking 0', () => {
    const r = buildHeartbeatSummaryResponse(empty, 0, 0, null)
    expect(r.counts.db_size_mb).toBeNull()
    expect(JSON.stringify(r)).toContain('"db_size_mb":null')
  })
})

describe('wiring contract: endpoint -> agent, never agent -> du/stat', () => {
  const KANBAN = readFileSync(join(ROOT, 'src', 'web', 'routes', 'kanban.ts'), 'utf-8')
  const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'heartbeat-agent-scaffold.ts'), 'utf-8')

  it('the heartbeat-summary handler passes getDbFileSizeMb() into the builder', () => {
    // Structurally-anchored window (the #1006 review lesson): handler start
    // marker to its own `return true`, never a window derived from the needle.
    const start = KANBAN.indexOf("'/api/kanban/heartbeat-summary'")
    expect(start).toBeGreaterThanOrEqual(0)
    const end = KANBAN.indexOf('return true', start)
    expect(end).toBeGreaterThan(start)
    expect(KANBAN.slice(start, end)).toMatch(/buildHeartbeatSummaryResponse\([\s\S]*getDbFileSizeMb\(\)/)
  })

  it('the scaffold names counts.db_size_mb as the ONLY source and forbids self-measurement', () => {
    expect(SCAFFOLD).toMatch(/counts\.db_size_mb/)
    // The one-line kanban command must surface the number in its measured
    // output, tolerant of older builds (dict.get, no KeyError).
    expect(SCAFFOLD).toMatch(/db_size_mb=%s/)
    expect(SCAFFOLD).toMatch(/c\.get\('db_size_mb'\)/)
    // The drifted surface itself: the template placeholder with no source.
    expect(SCAFFOLD).not.toMatch(/DB size: <X> MB/)
    // Missing/null degrades to "no data", never to a self-run measurement.
    expect(SCAFFOLD).toMatch(/DB size: nincs adat \(a summary nem adja\)/)
  })
})
