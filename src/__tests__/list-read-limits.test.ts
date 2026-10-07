// c4e47223 (2), from the review: the list-read section tells every agent
// where a list endpoint cuts on the server side, because a response the server
// cut at its limit is still rc=0, http=200 and valid JSON. The numbers the
// section quotes are MEASURED here on the real handlers over an in-memory DB,
// and the section's source text is held to them: a limit that changes in a
// route without the section changing fails this file.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import {
  initDatabase, createAgentMessage, saveAgentMemory, clearMemoryCache, createKanbanCard, archiveKanbanCard,
} from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

type Got = { headers: Record<string, string>; json: any }

async function get(handler: (ctx: RouteContext) => Promise<boolean>, pathAndQuery: string): Promise<Got> {
  const got: Got = { headers: {}, json: null }
  const res: any = {
    setHeader(k: string, v: string) { got.headers[k.toLowerCase()] = String(v); return res },
    writeHead(_status: number, h: Record<string, string> = {}) {
      for (const [k, v] of Object.entries(h)) got.headers[k.toLowerCase()] = String(v)
      return res
    },
    end(b?: string | Buffer) { if (b != null) got.json = JSON.parse(String(b)) },
  }
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  const req: any = Object.assign(Readable.from([]), { headers: {} })
  expect(await handler({ req, res, path: url.pathname, method: 'GET', url } as RouteContext)).toBe(true)
  return got
}

// The section as the source writes it (the body of buildListReadBody), not a
// render: the render interpolates install paths, the limits are literal text.
// The string literals are joined into one line of prose, whitespace collapsed.
const here = dirname(fileURLToPath(import.meta.url))
const scaffold = readFileSync(join(here, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
const source = scaffold.slice(
  scaffold.indexOf('export function buildListReadBody'),
  scaffold.indexOf('export function ensureListReadSection'),
)
const prose = source.split('\n')
  .map((line) => line.trim().replace(/^'/, '').replace(/',$/, ''))
  .join(' ')
  .replace(/\s+/g, ' ')

// One endpoint's bullet: from "- `GET <endpoint>`" to the next bullet.
function bullet(endpoint: string): string {
  const start = prose.indexOf(`- \`GET ${endpoint}\``)
  expect(start, `the section has no bullet for ${endpoint}`).toBeGreaterThanOrEqual(0)
  const next = prose.slice(start + 1).search(/ - `GET | - Ha bármelyik/)
  return next >= 0 ? prose.slice(start, start + 1 + next) : prose.slice(start)
}

const N = 210 // above every per-request cap below, so a cap shows as a count short of N

describe('the limits the list-read section quotes are the endpoints\' own (c4e47223)', () => {
  beforeAll(() => {
    initDatabase(':memory:')
    clearMemoryCache()
    for (let i = 0; i < N; i++) createAgentMessage('kuldo', 'olvaso', `uzenet ${i}`)
    for (let i = 0; i < N; i++) saveAgentMemory('emlekezo', `emlek ${i}`, 'warm', `kulcs${i}`)
    clearMemoryCache()
    for (let i = 0; i < 600; i++) createKanbanCard({ id: `k${i}`, title: `Lap ${i}`, assignee: 'lapos' })
    for (let i = 0; i < 12; i++) {
      createKanbanCard({ id: `a${i}`, title: `Archiv ${i}`, assignee: 'lapos' })
      archiveKanbanCard(`a${i}`)
    }
  })

  it('/api/messages?agent=: 50 by default, 200 at most, and nothing in the head says it was cut', async () => {
    const def = await get(tryHandleMessages, '/api/messages?agent=olvaso')
    const max = await get(tryHandleMessages, '/api/messages?agent=olvaso&limit=100000')
    expect(def.json).toHaveLength(50)
    expect(max.json).toHaveLength(200)
    expect(Object.keys(max.headers).filter((h) => /total|truncat|count/.test(h))).toEqual([])
    expect(bullet('/api/messages?agent=')).toContain(`alapból ${def.json.length}, legfeljebb ${max.json.length} sor`)
    expect(bullet('/api/messages?agent=')).toContain('csonkolás-jelzés nélkül')
  })

  it('/api/messages?agent=: only status=pending filters, and it returns the whole queue, uncapped', async () => {
    // Every row here is pending: a working "delivered" filter would return none.
    const delivered = await get(tryHandleMessages, '/api/messages?agent=olvaso&status=delivered')
    expect(delivered.json).toHaveLength(50)
    expect(delivered.json.every((m: { status: string }) => m.status === 'pending')).toBe(true)
    // Neither the default, nor the cap, nor the limit asked for.
    const pending = await get(tryHandleMessages, '/api/messages?agent=olvaso&status=pending&limit=10')
    expect(pending.json).toHaveLength(N)
    const b = bullet('/api/messages?agent=')
    expect(b).toContain('CSAK a `status=pending` szűr, és az a teljes függő sort adja, korlát nélkül')
    expect(b).toMatch(/Más `status` \(delivered, done, failed\) HATÁSTALAN/)
  })

  it('/api/messages?agent=: before=<smallest id received> pages back to the rest', async () => {
    const first = await get(tryHandleMessages, '/api/messages?agent=olvaso&limit=200')
    const smallest = Math.min(...first.json.map((m: { id: number }) => m.id))
    const second = await get(tryHandleMessages, `/api/messages?agent=olvaso&limit=200&before=${smallest}`)
    expect(second.json).toHaveLength(N - 200)
    expect(new Set([...first.json, ...second.json].map((m: { id: number }) => m.id)).size).toBe(N)
    expect(bullet('/api/messages?agent=')).toContain('`before=<a kapott legkisebb id>`')
  })

  it('/api/memories: 50 by default, 200 at most; the listing label says truncated at the cap, offset pages', async () => {
    const def = await get(tryHandleMemories, '/api/memories?agent=emlekezo')
    const max = await get(tryHandleMemories, '/api/memories?agent=emlekezo&limit=100000')
    const rest = await get(tryHandleMemories, `/api/memories?agent=emlekezo&limit=200&offset=${max.json.length}`)
    expect(def.json).toHaveLength(50)
    expect(max.json).toHaveLength(200)
    expect(max.headers['x-memory-search']).toContain('truncated=true')
    expect(rest.json).toHaveLength(N - 200)
    expect(rest.headers['x-memory-search']).toContain('truncated=false')
    const b = bullet('/api/memories')
    expect(b).toContain(`alapból ${def.json.length}, legfeljebb ${max.json.length} sor`)
    expect(b).toContain('`truncated=true`-t mond a korlátnál (lapozás: `offset=`)')
  })

  it('/api/kanban: the whole non-archived list with no cap; X-Total-Count is the array length', async () => {
    const all = await get(tryHandleKanban, '/api/kanban')
    expect(all.json).toHaveLength(600)
    expect(all.headers['x-total-count']).toBe('600')
    expect(all.json.some((c: { id: string }) => c.id.startsWith('a'))).toBe(false)
    const withArchived = await get(tryHandleKanban, '/api/kanban?includeArchived=1')
    expect(withArchived.json).toHaveLength(612)
    const b = bullet('/api/kanban')
    expect(b).toContain('korlát nélkül')
    expect(b).toContain('`includeArchived=1`')
    expect(b).toContain('`X-Total-Count`')
  })

  it('/api/kanban/archived: limit from KANBAN_ARCHIVED_MAX_ROWS (500), capped at 5000; total = limit at the cut', async () => {
    const def = await get(tryHandleKanban, '/api/kanban/archived')
    const huge = await get(tryHandleKanban, '/api/kanban/archived?limit=100000')
    const cut = await get(tryHandleKanban, '/api/kanban/archived?limit=10')
    expect(def.json.total).toBe(12)
    expect(def.json.limit).toBe(500)
    expect(huge.json.limit).toBe(5000)
    expect(cut.json).toMatchObject({ total: 10, limit: 10 })
    const b = bullet('/api/kanban/archived')
    expect(b).toContain(`(alapérték ${def.json.limit}, legfeljebb ${huge.json.limit})`)
    expect(b).toContain('`total < limit` a teljes, `total = limit` csonka lehet')
  })
})
