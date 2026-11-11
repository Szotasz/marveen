// DBSIZE1111: nothing writes a card title into token_usage any more. The collect route used to run a kanban
// correlation after every collect (the overview page calls it every 5 minutes); one run grew the DB from 704 to
// 1364 MB and held the event loop for 6.8 s. Step 2 deleted the correlation: the card is worked out when the
// rows are read (token-usage-card-attribution.test.ts). These tests pin that no write path is left, without
// waiting for a timer: the module exports no correlation, no production source writes task_title or project,
// and the real collect route leaves a NULL title NULL.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb, initDatabase } from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const spy = vi.hoisted(() => ({ collect: 0 }))

vi.mock('../web/token-usage.js', async () => {
  const actual = await vi.importActual<typeof import('../web/token-usage.js')>('../web/token-usage.js')
  return { ...actual, collectTokenUsage: async () => { spy.collect++; return { files: 0, inserted: 0 } } }
})

import { tryHandleTokenUsage } from '../web/routes/token-usage.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function productionSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') out.push(...productionSources(p))
    } else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

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

describe('no path writes a card title into token_usage (DBSIZE1111)', () => {
  it('the token-usage module exports no correlation', async () => {
    const mod = await vi.importActual<Record<string, unknown>>('../web/token-usage.js')
    expect(Object.keys(mod).filter((k) => /correlat/i.test(k))).toEqual([])
  })

  it('no production source sets task_title or project on token_usage', () => {
    const offenders: string[] = []
    for (const file of productionSources(SRC)) {
      const text = readFileSync(file, 'utf-8')
      // An UPDATE of token_usage that sets either column, in any statement shape.
      for (const m of text.matchAll(/UPDATE\s+token_usage\b[\s\S]{0,400}?\bSET\b[\s\S]{0,400}?\b(task_title|project)\s*=/gi)) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${m[0].slice(0, 80).replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the real collect route leaves a NULL title NULL, also with a card in_progress over the row', async () => {
    const db = getDb()
    const ts = 1716500000
    db.prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, content_preview, task_title)
      VALUES ('dbsize-agent', 's', ?, 100, 50, 0, 0, 'work', NULL)`).run(ts + 10)
    db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, assignee, created_at, updated_at, sort_order)
      VALUES ('dbsize-card', 'Card in the window', 'in_progress', 'normal', 'dbsize-agent', ?, ?, 0)`).run(ts, ts + 5)
    db.prepare(`INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at)
      VALUES ('dbsize-card', 'planned', 'in_progress', 't', ?)`).run(ts)
    const { out, run } = call('/api/token-usage/collect', 'POST')
    expect(await run()).toBe(true)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toMatchObject({ ok: true })
    expect(spy.collect).toBe(1)
    const stored = db.prepare("SELECT task_title, project FROM token_usage WHERE agent = 'dbsize-agent'").get()
    expect(stored).toEqual({ task_title: null, project: null })
  })
})
