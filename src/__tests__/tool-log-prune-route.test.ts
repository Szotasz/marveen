// POST /api/tool-log/prune, through tryHandleToolLog() with a fake req/res.
//
// The capture hook (scripts/hooks/tool-log-capture.py) posts an EMPTY body on
// ~1% of tool calls. Before TOOLLOGPRUNE24H1106 the parameterless path used a
// hard-coded 86400s, so that hook capped tool_call_log at 24 hours even with
// TOOL_CALL_LOG_RETENTION_DAYS unset (= keep forever). These cases pin the
// three behaviours that fix has to keep: retention governs the parameterless
// call, "keep forever" really keeps, and an explicit window still purges.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const { retention } = vi.hoisted(() => ({ retention: {} as Record<string, string | number> }))
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key in retention ? retention[key] : actual.getEffectiveSettingValue(key),
  }
})

const { initDatabase, getDb } = await import('../db.js')
const { tryHandleToolLog } = await import('../web/routes/tool-log.js')

const DAY = 86400
const NOW = () => Math.floor(Date.now() / 1000)

beforeAll(() => {
  // In-memory: the prune under test is an agent-agnostic DELETE and would
  // happily eat production history from store/claudeclaw.db.
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

function insert(sessionId: string, ageDays: number) {
  getDb()
    .prepare(
      `INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at)
       VALUES (?, 'Bash', 'x', 1, ?)`,
    )
    .run(sessionId, NOW() - ageDays * DAY)
}

function left(): string[] {
  const rows = getDb()
    .prepare('SELECT session_id FROM tool_call_log ORDER BY session_id')
    .all() as Array<{ session_id: string }>
  return rows.map((r) => r.session_id)
}

/** Fake ctx whose request body is `raw` (the hook sends the literal '{}'). */
function fakeCtx(raw: string) {
  const out = { status: 200, body: null as any }
  const res: any = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(chunk?: string) {
      if (chunk) out.body = JSON.parse(chunk)
    },
  }
  const req: any = {
    on(event: string, cb: (c?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(raw))
      if (event === 'end') cb()
      return req
    },
  }
  const url = new URL('http://localhost:3420/api/tool-log/prune')
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as any, out }
}

describe('POST /api/tool-log/prune', () => {
  beforeEach(() => {
    for (const k of Object.keys(retention)) delete retention[k]
    getDb().exec('DELETE FROM tool_call_log')
  })

  it('without a parameter honours TOOL_CALL_LOG_RETENTION_DAYS, not a 24h default', async () => {
    retention.TOOL_CALL_LOG_RETENTION_DAYS = 30
    insert('s-old', 45) // past the retention -> must go
    insert('s-mid', 10) // past the old 86400s default, INSIDE the retention -> must stay
    insert('s-new', 0)

    const { ctx, out } = fakeCtx('{}')
    expect(await tryHandleToolLog(ctx)).toBe(true)
    expect(out.body).toEqual({ ok: true })
    expect(left()).toEqual(['s-mid', 's-new'])
  })

  it('deletes nothing when retention is 0 (keep forever), which is the default', async () => {
    retention.TOOL_CALL_LOG_RETENTION_DAYS = 0
    insert('s-ancient', 400)
    insert('s-old', 45)
    insert('s-new', 0)

    const { ctx } = fakeCtx('{}')
    expect(await tryHandleToolLog(ctx)).toBe(true)
    expect(left()).toEqual(['s-ancient', 's-new', 's-old'])
  })

  it('still purges exactly the window an explicit older_than_secs names', async () => {
    retention.TOOL_CALL_LOG_RETENTION_DAYS = 0 // retention says keep forever...
    insert('s-old', 2)
    insert('s-new', 0)

    const { ctx } = fakeCtx(JSON.stringify({ older_than_secs: DAY }))
    expect(await tryHandleToolLog(ctx)).toBe(true)
    expect(left()).toEqual(['s-new']) // ...but an explicit purge still wins
  })
})
