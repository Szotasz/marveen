// DBSIZE1111: POST /api/token-usage/collect must not run the kanban correlation. The overview page calls the
// route every 5 minutes, and one correlation run grew the DB from 704 to 1364 MB and held the event loop for
// 6.8 s. The real route and the real correlateWithKanban run against an in-memory DB; only the JSONL scan
// (collectTokenUsage) is stubbed, so a NULL-titled row inside a card window stays NULL only if nothing correlates.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { getDb, initDatabase } from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const spy = vi.hoisted(() => ({ collect: 0, correlate: 0 }))

vi.mock('../web/token-usage.js', async () => {
  const actual = await vi.importActual<typeof import('../web/token-usage.js')>('../web/token-usage.js')
  return {
    ...actual,
    collectTokenUsage: async () => { spy.collect++; return { files: 0, inserted: 0 } },
    correlateWithKanban: () => { spy.correlate++; actual.correlateWithKanban() },
  }
})

import { tryHandleTokenUsage } from '../web/routes/token-usage.js'
import { correlateWithKanban } from '../web/token-usage.js'

function call(path: string, method: string) {
  const out = { status: 0, body: '' }
  const res = {
    writeHead: (s: number) => { out.status = s },
    setHeader: () => {},
    end: (b?: string) => { out.body = b ?? '' },
  }
  const ctx = { req: { headers: {} }, res, path, method, url: new URL(`http://localhost${path}`) }
  return { out, run: () => tryHandleTokenUsage(ctx as never) }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/token-usage/collect does not correlate with the kanban (DBSIZE1111)', () => {
  it('a NULL task_title inside a card window stays NULL after the collect, and the correlation is not called', async () => {
    const db = getDb()
    const ts = 1716500000
    const usage = db.prepare(`
      INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, content_preview, task_title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    usage.run('dbsize-agent', 'sess-dbsize', ts, 100, 50, 0, 0, 'before', null)
    usage.run('dbsize-agent', 'sess-dbsize', ts + 10, 100, 50, 0, 0, 'work', null)
    db.prepare(`
      INSERT INTO kanban_cards (id, title, status, priority, assignee, project, created_at, updated_at, sort_order)
      VALUES ('dbsize-card', 'Card in the window', 'in_progress', 'normal', 'dbsize-agent', 'p', ?, ?, 0)
    `).run(ts, ts + 5)
    const titles = () => (db.prepare("SELECT task_title FROM token_usage WHERE agent = 'dbsize-agent' ORDER BY timestamp").all() as { task_title: string | null }[]).map(r => r.task_title)
    try {
      const { out, run } = call('/api/token-usage/collect', 'POST')
      expect(await run()).toBe(true)
      expect(out.status).toBe(200)
      expect(JSON.parse(out.body)).toMatchObject({ ok: true })
      // Let a deferred run (setImmediate, a short timer) land before looking: fire-and-forget counts too.
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(spy.collect).toBe(1)
      expect(spy.correlate).toBe(0)
      expect(titles()).toEqual([null, null])

      // Control: the same rows DO get a title when the correlation runs, so the NULL above is the route's doing.
      correlateWithKanban()
      expect(titles()).toEqual([null, 'Card in the window'])
    } finally {
      db.prepare("DELETE FROM kanban_cards WHERE id = 'dbsize-card'").run()
      db.prepare("DELETE FROM token_usage WHERE agent = 'dbsize-agent'").run()
    }
  })
})
