import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// PUT /api/agents/:name/context-guard used to REPLACE the agent's stored row
// with the normalized body. normalize() fills every omitted key with its
// default, and `enabled` defaults to false (opt-in), so a partial body answered
// 200 {ok:true} while switching the guard off:
//
//   PUT {"limitTokens": 600000}  ->  200 {"ok":true,"contextGuard":{"enabled":false,...}}
//
// Measured on a live install (2026-10-16): a partial PUT that raised one
// agent's limitTokens left its guard off until the operator's read-back caught
// it. The dashboard's own guard panel has the same shape -- it sends 6 of the
// 12 fields -- so saving it silently reset the idle-flush and daily-handoff
// tiers. The endpoint now merges: an omitted key keeps its value.
const SANDBOX = mkdtempSync(join(tmpdir(), 'cgmerge-'))
mkdirSync(join(SANDBOX, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})

const STORE = join(SANDBOX, 'store', 'context-guard.json')
const { MAIN_AGENT_ID } = await import('../config.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { readContextGuardConfig } = await import('../web/context-guard-store.js')
const { DEFAULT_CONTEXT_GUARD } = await import('../context-guard.js')

async function putGuard(name: string, body: unknown): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(name)}/context-guard`)
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

// A row the way a long-running agent carries it: guard on, a raised window, a
// longer cooldown, and the idle-flush and daily-handoff tiers tuned away from
// their defaults -- every field a partial body could lose.
const TUNED = {
  ...DEFAULT_CONTEXT_GUARD,
  enabled: true,
  limitTokens: 500_000,
  cooldownMinutes: 30,
  idleFlushEnabled: true,
  idleFlushTokens: 300_000,
  idleMinutes: 5,
  dailyHandoffEnabled: true,
  dailyHandoffTime: '03:30',
}

function seed(row: unknown): void {
  writeFileSync(STORE, JSON.stringify({ [MAIN_AGENT_ID]: row }, null, 2))
}
function stored(): any {
  return JSON.parse(readFileSync(STORE, 'utf-8'))[MAIN_AGENT_ID]
}

beforeEach(() => rmSync(STORE, { force: true }))
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('PUT /api/agents/:name/context-guard merges a partial body', () => {
  it('a single-field PUT changes that field and leaves the guard on', async () => {
    seed(TUNED)
    const r = await putGuard(MAIN_AGENT_ID, { limitTokens: 600_000 })
    expect(r.status).toBe(200)
    expect(r.body?.contextGuard).toEqual({ ...TUNED, limitTokens: 600_000 })
    // The response is not the only witness: the stored row has to agree.
    expect(stored()).toEqual({ ...TUNED, limitTokens: 600_000 })
  })

  it("the dashboard guard panel's exact payload keeps the tiers it does not send", async () => {
    // Pinned from saveContextGuardBtn in web/app.js: six fields, and no
    // saturationRestart, idle-flush or daily-handoff among them. The panel
    // sends back what it displays, so only actPct/hardPct differ here.
    seed(TUNED)
    const r = await putGuard(MAIN_AGENT_ID, {
      enabled: true, actPct: 0.85, hardPct: 0.95,
      cooldownMinutes: 30, handoffTimeoutMinutes: 20, limitTokens: 500_000,
    })
    expect(r.status).toBe(200)
    expect(stored()).toEqual({ ...TUNED, actPct: 0.85, hardPct: 0.95 })
  })

  it('an explicit null still clears a nullable field', async () => {
    // null is a value the caller sent, not an omission.
    seed(TUNED)
    await putGuard(MAIN_AGENT_ID, { limitTokens: null, dailyHandoffTime: null })
    expect(stored().limitTokens).toBeNull()
    expect(stored().dailyHandoffTime).toBeNull()
    expect(stored().enabled).toBe(true)
  })

  it('a partial PUT on an agent with no row merges over the disabled default', async () => {
    // Merging must not arm anything: the opt-in default stays the base.
    const r = await putGuard(MAIN_AGENT_ID, { limitTokens: 600_000 })
    expect(r.status).toBe(200)
    expect(stored()).toEqual({ ...DEFAULT_CONTEXT_GUARD, limitTokens: 600_000 })
    expect(stored().enabled).toBe(false)
  })

  it('the merged result is still normalized as a whole', async () => {
    // hardPct may not sit below actPct, so raising actPct alone pulls it up.
    seed(TUNED)
    await putGuard(MAIN_AGENT_ID, { actPct: 0.98 })
    expect(stored().actPct).toBe(0.98)
    expect(stored().hardPct).toBe(0.98)
    // A malformed VALUE is coerced the way it always was -- to the default,
    // not to the previous value: the merge is about omitted keys only.
    await putGuard(MAIN_AGENT_ID, { cooldownMinutes: -5 })
    expect(stored().cooldownMinutes).toBe(DEFAULT_CONTEXT_GUARD.cooldownMinutes)
  })

  it('a full round-tripped config saves exactly as before', async () => {
    seed(TUNED)
    const full = { ...TUNED, enabled: false, idleFlushEnabled: false }
    await putGuard(MAIN_AGENT_ID, full)
    expect(stored()).toEqual(full)
    expect(readContextGuardConfig(MAIN_AGENT_ID)).toEqual(full)
  })

  it('an unknown key is still refused, and nothing is written', async () => {
    seed(TUNED)
    const before = readFileSync(STORE, 'utf-8')
    const r = await putGuard(MAIN_AGENT_ID, { limitTokens: 600_000, limitToken: 1 })
    expect(r.status).toBe(400)
    expect(r.body?.rejected).toEqual(['limitToken'])
    expect(readFileSync(STORE, 'utf-8')).toBe(before)
  })
})
