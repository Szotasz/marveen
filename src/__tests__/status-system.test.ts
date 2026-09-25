import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// The route tests pin the local part so they measure the ROUTE contract; the
// pure helpers below use the real module.
const sysMock = vi.hoisted(() => ({ fn: null as null | (() => Promise<unknown>) }))
vi.mock('../web/system-status.js', async (orig) => {
  const m = await orig<typeof import('../web/system-status.js')>()
  return {
    ...m,
    getSystemStatus: (...a: Parameters<typeof m.getSystemStatus>) => (sysMock.fn ? sysMock.fn() : m.getSystemStatus(...a)),
  }
})

import {
  runCollectors,
  formatSystemStatus,
  summarizeTaskRuns,
  formatQuota,
  normalizeModelId,
  modelsDiffer,
  cacheHitRatio,
  getSystemStatus,
  liveBlockSpecs,
  telegramPluginPatchStatus,
  type SystemStatus,
} from '../web/system-status.js'
import { tryHandleStatus } from '../web/routes/status.js'
import { initDatabase } from '../db.js'

// ---- CMD920 test 11: one throwing collector, the rest still render ----------

describe('/status collectors', () => {
  it('a throwing collector gets an error, every other row still appears', async () => {
    const s = await runCollectors([
      { title: 'A', rows: [
        { label: 'jó', source: 's1', collect: () => 'érték' },
        { label: 'rossz', source: 's2', collect: () => { throw new Error('elszállt') } },
        { label: 'async', source: 's3', collect: async () => 'később' },
      ] },
      { title: 'B', rows: [{ label: 'rossz async', source: 's4', collect: async () => { throw new Error('timeout') } }] },
    ])
    expect(s.blocks[0].rows).toEqual([
      { label: 'jó', value: 'érték', source: 's1' },
      { label: 'rossz', value: null, source: 's2', error: 'elszállt' },
      { label: 'async', value: 'később', source: 's3' },
    ])
    const text = formatSystemStatus(s)
    expect(text).toBe('A\njó: érték\nrossz: hiba (elszállt)\nasync: később\n\nB\nrossz async: hiba (timeout)')
  })

  it('the live collectors never throw as a whole; every row has a value or an error', async () => {
    initDatabase(':memory:')
    const s = await getSystemStatus({ noCache: true, specs: liveBlockSpecs() })
    expect(s.blocks.map(b => b.title)).toEqual(['MARVEEN', 'KERET', 'ÜTEMEZŐ (24 óra)', 'CSATORNA', 'RENDSZER'])
    for (const b of s.blocks) for (const r of b.rows) {
      expect(r.value !== null || typeof r.error === 'string').toBe(true)
      expect(r.source.length).toBeGreaterThan(0)
    }
  }, 20_000)
})

// ---- CMD920 test 12: task_runs by outcome -----------------------------------

describe('scheduler row (task_runs, by outcome)', () => {
  it('skipped-precheck stays apart from skipped; done/lost counted by outcome', () => {
    const t = summarizeTaskRuns([
      { status: 'fired', outcome: 'done', completed_at: 1 },
      { status: 'fired', outcome: 'done', completed_at: 1 },
      { status: 'fired', outcome: 'lost', completed_at: 1 },
      { status: 'fired', outcome: null, completed_at: null },
      { status: 'skipped-precheck', outcome: null, completed_at: 1 },
      { status: 'skipped-precheck', outcome: null, completed_at: 1 },
      { status: 'skipped', outcome: null, completed_at: 1 },
      { status: 'lost-giveup', outcome: null, completed_at: 1 },
    ])
    expect(t).toBe('lefutott 2 · skipped-precheck 2 · nyitott 1 · skipped 1 · elveszett 2')
  })

  it('empty window -> "nincs adat", never "0 hiba"', () => {
    expect(summarizeTaskRuns([])).toBe('nincs adat (üres ablak)')
  })
})

// ---- CMD920 test 13: quota not measurable, no estimate ----------------------

describe('quota rows', () => {
  it('missing / stale reading -> "nem mérhető", never a number', () => {
    const miss = formatQuota({ status: 'missing', reason: 'no-file', ageSec: null, maxAgeSec: 1, fiveHour: null, sevenDay: null })
    expect(miss.fiveHour).toMatch(/^nem mérhető/)
    expect(miss.sevenDay).toMatch(/^nem mérhető/)
    const stale = formatQuota({ status: 'stale', ageSec: 7 * 3600, maxAgeSec: 21600, fiveHour: { usedPercentage: 40, resetsAt: null, expired: false }, sevenDay: null })
    expect(stale.fiveHour).toMatch(/^nem mérhető \(elavult/)
    expect(stale.fiveHour).not.toMatch(/40/)
  })

  it('fresh reading shows the measured percentage; an expired window is not shown as current', () => {
    const q = formatQuota({ status: 'ok', ageSec: 5, maxAgeSec: 21600, fiveHour: { usedPercentage: 23.4, resetsAt: null, expired: false }, sevenDay: { usedPercentage: 74, resetsAt: 1, expired: true } })
    expect(q.fiveHour).toBe('23%')
    expect(q.sevenDay).toMatch(/^nem mérhető \(az ablak lejárt/)
  })
})

// ---- CMD920 test 4: raw print, normalized compare --------------------------

describe('model id comparison', () => {
  it('normalizes [1m] and a trailing date, nothing else', () => {
    expect(modelsDiffer('claude-opus-5', 'claude-opus-5')).toBe(false)
    expect(modelsDiffer('claude-opus-5[1m]', 'claude-opus-5')).toBe(false)
    expect(modelsDiffer('claude-haiku-4-5', 'claude-haiku-4-5-20251001')).toBe(false)
    expect(modelsDiffer('claude-sonnet-5', 'claude-sonnet-4-6')).toBe(true)
    expect(normalizeModelId('claude-opus-5[1m]')).toBe('claude-opus-5')
  })
})

describe('cache hit ratio (24 h window)', () => {
  it('cache_read over all input, only inside the window', () => {
    const at = (iso: string, u: object) => JSON.stringify({ timestamp: iso, message: { usage: u } })
    const lines = [
      at('2026-09-20T00:00:00Z', { input_tokens: 1000, cache_read_input_tokens: 0 }),
      at('2026-09-22T00:00:00Z', { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 }),
      'nem json "usage"',
    ]
    expect(cacheHitRatio(lines, Date.parse('2026-09-21T00:00:00Z'))).toBeCloseTo(0.9)
    expect(cacheHitRatio(lines, Date.parse('2026-09-23T00:00:00Z'))).toBeNull()
  })
})

// ---- CMD920 tests 14, 15: /api/status ---------------------------------------

const SYSTEM: SystemStatus = { generatedAt: 1, blocks: [{ title: 'MARVEEN', rows: [{ label: 'Verzió', value: '1.0', source: 'package.json' }] }] }

function fakeReqRes(query = '') {
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; return this },
    setHeader() {},
    end(b?: string | Buffer) { this.body = b ? b.toString() : '' },
  }
  const req = { headers: {} } as unknown as http.IncomingMessage
  const url = new URL(`http://x/api/status${query}`)
  return { res, ctx: { req, res: res as unknown as http.ServerResponse, path: '/api/status', method: 'GET', url } }
}

const RSS = '<rss><item><title>Elevated errors</title><description>Resolved - fixed</description><pubDate>Mon</pubDate><link>l</link></item></rss>'

describe('/api/status', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    sysMock.fn = async () => SYSTEM
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes('history.rss')) return { ok: true, status: 200, text: async () => RSS }
      return { ok: true, status: 200, json: async () => ({ components: [{ name: 'API', status: 'operational' }, { name: 'grp', status: 'x', group: true }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    sysMock.fn = null
    vi.unstubAllGlobals()
  })

  it('the legacy fields keep their exact shape and order; system is added after them', async () => {
    const { res, ctx } = fakeReqRes()
    expect(await tryHandleStatus(ctx as never)).toBe(true)
    const body = JSON.parse(res.body)
    expect(Object.keys(body)).toEqual(['overall', 'components', 'incidents', 'fetchedAt', 'system'])
    expect(body.overall).toBe('operational')
    expect(body.components).toEqual([{ name: 'API', status: 'operational' }])
    expect(body.incidents).toEqual([{ title: 'Elevated errors', description: 'Resolved - fixed', pubDate: 'Mon', link: 'l', status: 'resolved' }])
    expect(typeof body.fetchedAt).toBe('number')
    expect(body.system).toEqual(SYSTEM)
  })

  it('?only=system makes no network call', async () => {
    const { res, ctx } = fakeReqRes('?only=system')
    await tryHandleStatus(ctx as never)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(res.body)).toEqual({ system: SYSTEM })
  })

  it('?only=anthropic is the legacy response, byte for byte (no system key)', async () => {
    const { res, ctx } = fakeReqRes('?only=anthropic')
    await tryHandleStatus(ctx as never)
    expect(Object.keys(JSON.parse(res.body))).toEqual(['overall', 'components', 'incidents', 'fetchedAt'])
  })

  it('an invalid ?only= is a 400, not a silent default', async () => {
    const { res, ctx } = fakeReqRes('?only=mind')
    await tryHandleStatus(ctx as never)
    expect(res.status).toBe(400)
  })

  it('Anthropic timeout -> overall unknown with the legacy error shape, system still complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted due to timeout') }))
    const { res, ctx } = fakeReqRes()
    await tryHandleStatus(ctx as never)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ overall: 'unknown', components: [], incidents: [], error: 'Failed to fetch status' })
    expect(Object.keys(body)).toEqual(['overall', 'components', 'incidents', 'fetchedAt', 'error', 'system'])
    expect(body.system).toEqual(SYSTEM)
  })

  it('a crashing system collection does not take the Anthropic fields down', async () => {
    sysMock.fn = async () => { throw new Error('db gone') }
    const { res, ctx } = fakeReqRes()
    await tryHandleStatus(ctx as never)
    const body = JSON.parse(res.body)
    expect(body.overall).toBe('operational')
    expect(body.system).toEqual({ error: 'db gone' })
  })

  it('the local part does not wait for a slow Anthropic fetch in ?only=system', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never resolves */ })))
    const { res, ctx } = fakeReqRes('?only=system')
    await tryHandleStatus(ctx as never)
    expect(JSON.parse(res.body).system).toEqual(SYSTEM)
  })
})

// ---- review #1529 point 4c: the Telegram plugin patch is visible ------------

describe('Telegram plugin-patch row', () => {
  let dir = ''
  let state = ''
  const server = (v: string, text: string) => {
    const d = join(dir, 'cache', 'claude-plugins-official', 'telegram', v)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'server.ts'), text)
  }
  const writeState = (files: Array<{ version: string; status: string }>) =>
    writeFileSync(state, JSON.stringify({ at: 0, root: join(dir, 'cache'), files }))
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plugin-patch-row-')); state = join(dir, 'state.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('patched: "rendben" with the version', () => {
    server('0.0.7', '// MARVEEN-PATCH(elsokor922-d4): x')
    writeState([{ version: '0.0.7', status: 'patched' }])
    expect(telegramPluginPatchStatus(state)).toBe('rendben (0.0.7)')
  })

  it('anchor-missing / unwritable at start: one line naming the version, the reason and the fallback', () => {
    server('0.0.8', 'plugin code')
    writeState([{ version: '0.0.8', status: 'anchor-missing:status handler' }])
    expect(telegramPluginPatchStatus(state)).toBe('HIÁNYZIK: 0.0.8 (anchor-missing:status handler) · a /status és a /help a plugin saját válasza')
    writeState([{ version: '0.0.8', status: 'unwritable' }])
    expect(telegramPluginPatchStatus(state)).toMatch(/^HIÁNYZIK: 0\.0\.8 \(unwritable\)/)
  })

  it('a plugin version that arrived after the start is measured now, not taken from the state file', () => {
    server('0.0.7', '// MARVEEN-PATCH(elsokor922-d4): x')
    server('0.0.9', 'fresh plugin code')
    writeState([{ version: '0.0.7', status: 'already' }])
    expect(telegramPluginPatchStatus(state)).toMatch(/^HIÁNYZIK: 0\.0\.9 \(új verzió/)
  })

  it('no state file: says so instead of vanishing', () => {
    expect(telegramPluginPatchStatus(state)).toMatch(/^nincs adat/)
  })

  it('is a CSATORNA row of the live /status', () => {
    const csatorna = liveBlockSpecs().find(b => b.title === 'CSATORNA')!
    expect(csatorna.rows.map(r => r.label)).toContain('Telegram plugin-patch')
  })
})
