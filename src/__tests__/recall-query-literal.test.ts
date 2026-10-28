/**
 * GET /api/recall with q=: the query is a literal substring on every branch.
 *
 * With date= AND q= the route filters the date window in JS. It used to run the
 * query through the LIKE escaper first and then compare with String.includes(),
 * so `22%` became `22\%` and `snake_case` became `snake\_case`: a query holding
 * `%` or `_` never matched the memory or log that contains it, while a plain
 * word did. The escaper belongs to `LIKE ? ESCAPE '\'` only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    MAIN_AGENT_ID: 'main',
    ALLOWED_CHAT_ID: 'test-chat',
    OLLAMA_URL: '',
    APP_TZ: 'Europe/Budapest',
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb, clearMemoryCache } from '../db.js'
import { tryHandleRecall } from '../web/routes/recall.js'
import { toBudapestTs } from '../date-range.js'
import type { RouteContext } from '../web/routes/types.js'

async function recall(pathAndQuery: string) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() {},
    end(chunk?: any) { if (chunk) out.body = JSON.parse(chunk.toString()) },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  await tryHandleRecall({ req, res, path: url.pathname, method: 'GET', url } as RouteContext)
  return out
}

const DAY_ISO = '2026-10-05'
const TS = toBudapestTs(DAY_ISO, false) + 12 * 3600

function insertMemory(content: string, keywords: string | null = null) {
  getDb().prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords)
     VALUES ('test-chat', NULL, ?, 'semantic', 1.0, ?, ?, 'agent-a', 'warm', 0, ?)`
  ).run(content, TS, TS, keywords)
}

function insertLog(content: string) {
  getDb().prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)')
    .run('agent-a', DAY_ISO, content, TS)
}

const q = (s: string) => encodeURIComponent(s)

beforeEach(() => {
  initDatabase(':memory:')
  clearMemoryCache()
  insertMemory('discount raised to 22% for the autumn')
  insertMemory('renamed the column to snake_case everywhere')
  insertMemory('plain control memory about tomatoes')
  insertMemory('keyword-only row', 'rate_limit, 5%')
  insertLog('## 10:00 -- set the fee to 22% today')
  insertLog('## 11:00 -- moved my_setting into config')
  insertLog('## 12:00 -- watered the tomatoes')
})

describe('/api/recall date= + q=: the query is compared literally', () => {
  it('control: a plain word matches memories and logs', async () => {
    const r = await recall(`/api/recall?agent=agent-a&date=${DAY_ISO}&q=tomatoes`)
    expect(r.status).toBe(200)
    expect(r.body.memories.map((m: any) => m.content)).toEqual(['plain control memory about tomatoes'])
    expect(r.body.logs.map((l: any) => l.content)).toEqual(['## 12:00 -- watered the tomatoes'])
  })

  it('a query with % matches the rows that contain it', async () => {
    const r = await recall(`/api/recall?agent=agent-a&date=${DAY_ISO}&q=${q('22%')}`)
    expect(r.body.memories.map((m: any) => m.content)).toEqual(['discount raised to 22% for the autumn'])
    expect(r.body.logs.map((l: any) => l.content)).toEqual(['## 10:00 -- set the fee to 22% today'])
  })

  it('a query with _ matches the rows that contain it', async () => {
    const mem = await recall(`/api/recall?agent=agent-a&date=${DAY_ISO}&q=snake_case`)
    expect(mem.body.memories.map((m: any) => m.content)).toEqual(['renamed the column to snake_case everywhere'])
    const log = await recall(`/api/recall?agent=agent-a&date=${DAY_ISO}&q=my_setting`)
    expect(log.body.logs.map((l: any) => l.content)).toEqual(['## 11:00 -- moved my_setting into config'])
  })

  it('the keywords column is compared literally too', async () => {
    const r = await recall(`/api/recall?agent=agent-a&date=${DAY_ISO}&q=rate_limit`)
    expect(r.body.memories.map((m: any) => m.content)).toEqual(['keyword-only row'])
  })

  it('% and _ stay literal: they are not wildcards', async () => {
    const pct = await recall(`/api/recall?agent=agent-a&date=${DAY_ISO}&q=${q('%')}`)
    expect(pct.body.memories.map((m: any) => m.content).sort()).toEqual(['discount raised to 22% for the autumn', 'keyword-only row'])
    expect(pct.body.logs).toHaveLength(1)
    const us = await recall(`/api/recall?agent=agent-a&date=${DAY_ISO}&q=${q('o_t')}`)
    expect(us.body.memories).toEqual([])
    expect(us.body.logs).toEqual([])
  })
})

describe('/api/recall q= without date=: the SQL LIKE path is already literal', () => {
  it('daily logs with % and _ are found, and % is not a wildcard', async () => {
    const pct = await recall(`/api/recall?agent=agent-a&q=${q('22%')}`)
    expect(pct.body.logs.map((l: any) => l.content)).toEqual(['## 10:00 -- set the fee to 22% today'])
    const us = await recall(`/api/recall?agent=agent-a&q=my_setting`)
    expect(us.body.logs.map((l: any) => l.content)).toEqual(['## 11:00 -- moved my_setting into config'])
    const wild = await recall(`/api/recall?agent=agent-a&q=${q('o_t')}`)
    expect(wild.body.logs).toEqual([])
  })
})
