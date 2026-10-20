import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// PUT /api/agents/:name/auto-restart used to REPLACE the agent's stored row
// with the normalized body. normalize() fills every omitted key with its
// default, so a partial body answered 200 {ok:true} while resetting what it
// did not mention:
//
//   PUT {"mode": "fresh"}  ->  200 {"ok":true,"autoRestart":{"enabled":false,...}}
//
// The dashboard's own save has the same shape: it sends enabled, mode,
// dailyTime and intervalHours, never openQuestionDeferralCapHours, so every
// save put that cap back to 24. The endpoint now merges: an omitted key keeps
// its value. dailyTime/intervalHours are one schedule, not two keys, so a
// valid value for one of them, sent alone, clears the other -- otherwise a
// switch from a daily to an interval restart would silently keep the daily one.
const SANDBOX = mkdtempSync(join(tmpdir(), 'armerge-'))
mkdirSync(join(SANDBOX, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})

const STORE = join(SANDBOX, 'store', 'auto-restart.json')
const { MAIN_AGENT_ID } = await import('../config.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { DEFAULT_AUTO_RESTART } = await import('../auto-restart.js')

async function putAutoRestart(name: string, body: unknown): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(name)}/auto-restart`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'PUT', url } as unknown as RouteContext,
    join(SANDBOX, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

// A row the way a tuned agent carries it: on, fresh, a daily slot, and a
// deferral cap raised away from its default -- every field a partial body
// could lose.
const DAILY = {
  ...DEFAULT_AUTO_RESTART,
  enabled: true,
  mode: 'fresh',
  dailyTime: '03:30',
  intervalHours: null,
  openQuestionDeferralCapHours: 48,
}
const INTERVAL = { ...DAILY, dailyTime: null, intervalHours: 6 }

function seed(row: unknown): void {
  writeFileSync(STORE, JSON.stringify({ [MAIN_AGENT_ID]: row }, null, 2))
}
function stored(): any {
  return JSON.parse(readFileSync(STORE, 'utf-8'))[MAIN_AGENT_ID]
}

beforeEach(() => rmSync(STORE, { force: true }))
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('PUT /api/agents/:name/auto-restart -- merge, not replace', () => {
  it('keeps every key a single-field body leaves out', async () => {
    seed(DAILY)
    const r = await putAutoRestart(MAIN_AGENT_ID, { mode: 'continue' })
    expect(r.status).toBe(200)
    expect(r.body.autoRestart).toEqual({ ...DAILY, mode: 'continue' })
    expect(stored()).toEqual({ ...DAILY, mode: 'continue' })
  })

  it("keeps openQuestionDeferralCapHours across the dashboard's own save", async () => {
    seed(DAILY)
    // The exact shape saveAutoRestartBtn sends (web/app.js).
    const r = await putAutoRestart(MAIN_AGENT_ID, {
      enabled: true, mode: 'fresh', dailyTime: '04:00', intervalHours: null,
    })
    expect(r.status).toBe(200)
    expect(stored()).toEqual({ ...DAILY, dailyTime: '04:00', openQuestionDeferralCapHours: 48 })
  })

  it('switches a daily schedule to an interval when only intervalHours is sent', async () => {
    seed(DAILY)
    const r = await putAutoRestart(MAIN_AGENT_ID, { intervalHours: 6 })
    expect(r.status).toBe(200)
    // A plain merge would keep dailyTime, and normalize() lets dailyTime win,
    // so the interval the caller asked for would be dropped behind a 200.
    expect(stored()).toEqual({ ...DAILY, dailyTime: null, intervalHours: 6 })
  })

  it('switches an interval schedule to daily when only dailyTime is sent', async () => {
    seed(INTERVAL)
    const r = await putAutoRestart(MAIN_AGENT_ID, { dailyTime: '05:15' })
    expect(r.status).toBe(200)
    expect(stored()).toEqual({ ...INTERVAL, dailyTime: '05:15', intervalHours: null })
  })

  it('treats an explicit null as a value: it clears that key and switches nothing', async () => {
    seed(DAILY)
    await putAutoRestart(MAIN_AGENT_ID, { dailyTime: null })
    expect(stored()).toEqual({ ...DAILY, dailyTime: null })
    seed(INTERVAL)
    await putAutoRestart(MAIN_AGENT_ID, { intervalHours: null })
    expect(stored()).toEqual({ ...INTERVAL, intervalHours: null })
  })

  it('does not let a malformed value clear the other half of the schedule', async () => {
    seed(INTERVAL)
    const r = await putAutoRestart(MAIN_AGENT_ID, { dailyTime: '25:00' })
    expect(r.status).toBe(200)
    // Coerced to null exactly as before; the stored interval survives.
    expect(stored()).toEqual(INTERVAL)
  })

  // ARPUTTESTGAP1018: the mirror of the two cases above, on a DAILY row. Only the
  // dailyTime side was pinned; dropping the validity check on the intervalHours
  // side (so any intervalHours key cleared dailyTime) stayed green. A null or
  // malformed intervalHours must not switch a daily schedule off.
  it('does not let a null or malformed intervalHours clear a daily schedule', async () => {
    for (const intervalHours of [null, 'abc', 0, -3]) {
      seed(DAILY)
      const r = await putAutoRestart(MAIN_AGENT_ID, { intervalHours })
      expect(r.status, String(intervalHours)).toBe(200)
      expect(stored(), String(intervalHours)).toEqual(DAILY)
    }
  })

  it('never enables auto-restart for an agent with no row', async () => {
    const r = await putAutoRestart(MAIN_AGENT_ID, { mode: 'fresh', dailyTime: '03:00' })
    expect(r.status).toBe(200)
    expect(stored()).toEqual({ ...DEFAULT_AUTO_RESTART, mode: 'fresh', dailyTime: '03:00' })
    expect(stored().enabled).toBe(false)
  })

  it('still refuses an unknown key with 400 and writes nothing', async () => {
    seed(DAILY)
    const before = readFileSync(STORE, 'utf-8')
    const r = await putAutoRestart(MAIN_AGENT_ID, { enabled: false, intervalHourz: 6 })
    expect(r.status).toBe(400)
    expect(r.body?.rejected).toEqual(['intervalHourz'])
    expect(readFileSync(STORE, 'utf-8')).toBe(before)
  })

  it('accepts the legacy handoff key and still never stores it', async () => {
    seed(DAILY)
    const r = await putAutoRestart(MAIN_AGENT_ID, { enabled: true, handoff: false })
    expect(r.status).toBe(200)
    expect('handoff' in stored()).toBe(false)
    expect(stored()).toEqual(DAILY)
  })

  it('saves a full round-tripped body exactly as before', async () => {
    seed(DAILY)
    const full = { ...INTERVAL, mode: 'continue', openQuestionDeferralCapHours: 12 }
    const r = await putAutoRestart(MAIN_AGENT_ID, full)
    expect(r.status).toBe(200)
    expect(stored()).toEqual(full)
    expect(existsSync(STORE)).toBe(true)
  })
})
