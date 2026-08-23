import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// ---------- in-memory DB setup ----------

function buildDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('tool_call', 'skill_read')),
      session_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  return db
}

type DB = ReturnType<typeof buildDb>

function insert(db: DB, row: { agent_id: string; skill_name: string; created_at: number }) {
  db.prepare(
    'INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES (?, ?, ?, NULL, ?)',
  ).run(row.agent_id, row.skill_name, 'tool_call', row.created_at)
}

// Pure re-implementation of getSkillUsageSummary() SQL, operating on the in-memory DB.
function getSkillUsageSummary(db: DB) {
  const now = Math.floor(Date.now() / 1000)
  const cutoff30 = now - 30 * 86400
  const cutoff90 = now - 90 * 86400
  return db.prepare(`
    SELECT
      skill_name,
      MAX(created_at) AS last_used_at,
      COUNT(*) AS total_count,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS count_30d,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS count_90d
    FROM skill_usage
    GROUP BY skill_name
    ORDER BY last_used_at DESC
  `).all(cutoff30, cutoff90) as Array<{
    skill_name: string
    last_used_at: number
    total_count: number
    count_30d: number
    count_90d: number
  }>
}

// ---------- tests ----------

describe('getSkillUsageSummary SQL', () => {
  let db: DB
  const now = Math.floor(Date.now() / 1000)
  const day = 86400

  beforeEach(() => { db = buildDb() })

  it('returns empty array when table is empty', () => {
    expect(getSkillUsageSummary(db)).toEqual([])
  })

  it('returns correct total_count for a single skill', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 5 * day })
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 10 * day })
    const rows = getSkillUsageSummary(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].skill_name).toBe('skill-x')
    expect(rows[0].total_count).toBe(2)
  })

  it('count_30d only counts rows within 30 days', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 5 * day })   // within 30d
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 20 * day })  // within 30d
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 40 * day })  // outside 30d, within 90d
    const rows = getSkillUsageSummary(db)
    expect(rows[0].count_30d).toBe(2)
    expect(rows[0].count_90d).toBe(3)
    expect(rows[0].total_count).toBe(3)
  })

  it('count_90d only counts rows within 90 days', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 5 * day })    // 30d + 90d
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 60 * day })   // 90d only
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 100 * day })  // neither
    const rows = getSkillUsageSummary(db)
    expect(rows[0].count_30d).toBe(1)
    expect(rows[0].count_90d).toBe(2)
    expect(rows[0].total_count).toBe(3)
  })

  it('last_used_at is MAX(created_at) per skill', () => {
    const old = now - 60 * day
    const recent = now - 2 * day
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: old })
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: recent })
    const rows = getSkillUsageSummary(db)
    expect(rows[0].last_used_at).toBe(recent)
  })

  it('groups by skill_name -- multiple skills get separate rows', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 5 * day })
    insert(db, { agent_id: 'agent-b', skill_name: 'skill-y', created_at: now - 3 * day })
    const rows = getSkillUsageSummary(db)
    expect(rows).toHaveLength(2)
    const names = rows.map(r => r.skill_name)
    expect(names).toContain('skill-x')
    expect(names).toContain('skill-y')
  })

  it('orders by last_used_at DESC -- most recently used first', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-old', created_at: now - 50 * day })
    insert(db, { agent_id: 'agent-b', skill_name: 'skill-new', created_at: now - 1 * day })
    const rows = getSkillUsageSummary(db)
    expect(rows[0].skill_name).toBe('skill-new')
    expect(rows[1].skill_name).toBe('skill-old')
  })

  it('skill never used in 30d has count_30d=0 but correct total', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 100 * day })
    const rows = getSkillUsageSummary(db)
    expect(rows[0].count_30d).toBe(0)
    expect(rows[0].count_90d).toBe(0)
    expect(rows[0].total_count).toBe(1)
  })

  it('different agents using same skill count toward the same row', () => {
    insert(db, { agent_id: 'agent-a', skill_name: 'skill-x', created_at: now - 2 * day })
    insert(db, { agent_id: 'agent-b', skill_name: 'skill-x', created_at: now - 3 * day })
    insert(db, { agent_id: 'agent-c', skill_name: 'skill-x', created_at: now - 4 * day })
    const rows = getSkillUsageSummary(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].total_count).toBe(3)
  })
})

// ---------- route-level contract tests ----------
import { describe as descRoute, it as itRoute, expect as expectRoute, vi, beforeEach as routeBeforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockGetSkillUsageSummary } = vi.hoisted(() => ({
  mockGetSkillUsageSummary: vi.fn(),
}))
vi.mock('../db.js', () => ({
  logSkillUsage: vi.fn(),
  getSkillUsageRows: vi.fn().mockReturnValue([]),
  getSkillUsageStats: vi.fn().mockReturnValue([]),
  getSkillUsageSummary: mockGetSkillUsageSummary,
}))

import { tryHandleSkillUsage } from '../web/routes/skill-usage.js'

function makeCtx(method: string, path: string): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const req = new EventEmitter() as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', Buffer.alloc(0)); req.emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as unknown as import('node:http').ServerResponse
  const url = new URL('http://localhost' + path)
  const ctx: RouteContext = { req: req as unknown as import('node:http').IncomingMessage, res, path: url.pathname, method, url }
  return { ctx, out }
}

descRoute('GET /api/skill-usage/summary route', () => {
  routeBeforeEach(() => vi.clearAllMocks())

  itRoute('returns summary array from db', async () => {
    const fixture = [{ skill_name: 'skill-x', last_used_at: 1700000000, total_count: 5, count_30d: 3, count_90d: 5 }]
    mockGetSkillUsageSummary.mockReturnValue(fixture)
    const { ctx, out } = makeCtx('GET', '/api/skill-usage/summary')
    const handled = await tryHandleSkillUsage(ctx)
    expectRoute(handled).toBe(true)
    expectRoute(out.status).toBe(200)
    expectRoute(out.body).toEqual(fixture)
  })

  itRoute('returns empty array when no usage data', async () => {
    mockGetSkillUsageSummary.mockReturnValue([])
    const { ctx, out } = makeCtx('GET', '/api/skill-usage/summary')
    await tryHandleSkillUsage(ctx)
    expectRoute(out.body).toEqual([])
  })

  itRoute('does not interfere with /api/skill-usage/stats', async () => {
    const { ctx, out } = makeCtx('GET', '/api/skill-usage/stats')
    const handled = await tryHandleSkillUsage(ctx)
    expectRoute(handled).toBe(true)
    expectRoute(mockGetSkillUsageSummary).not.toHaveBeenCalled()
  })
})
