import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { initDatabase, createAgentMessage, getAgentMessage, getPendingMessages } from '../db.js'
import { deliverFederatedBatch } from '../web/message-router.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { _setFederationStoreDirForTest, reloadFederationForTest } from '../web/federation/config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'
import type { RouteContext } from '../web/routes/types.js'

// Fixture agent directories required by the from-auth check in /api/messages.
// 'localboss' is the fictional test sender used throughout this suite.
const FIXTURE_AGENTS = ['localboss']

const TMP = mkdtempSync(join(tmpdir(), 'fed-feedback-test-'))
const IN_TOKEN = 'b'.repeat(64)
const OUT_TOKEN = 'c'.repeat(64)

function writeEnabledConfig(): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
    enabled: true, systemId: 'localsys',
    peers: [{ id: 'teodor', baseUrl: 'https://mini.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN }],
  }))
  reloadFederationForTest()
}

async function postMessage(body: unknown): Promise<{ statusCode: number; json: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleMessages({
    req, res, path: '/api/messages', method: 'POST',
    url: new URL('http://localhost/api/messages'), fedPeer: null,
  })
  expect(handled).toBe(true)
  return { statusCode: state.statusCode || 200, json: state.body ? JSON.parse(state.body) : null }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  // Create minimal fixture agent directories so isKnownAgent() recognises the
  // test senders. These are torn down in afterAll.
  for (const name of FIXTURE_AGENTS) {
    mkdirSync(join(AGENTS_BASE_DIR, name), { recursive: true })
  }
})

beforeEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
  _setFederationStoreDirForTest(TMP)
  writeEnabledConfig()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
  for (const name of FIXTURE_AGENTS) {
    rmSync(join(AGENTS_BASE_DIR, name), { recursive: true, force: true })
  }
})

describe('POST /api/messages colon-form to guard (L5)', () => {
  it('rejects a "federation:x:y" source-form recipient with 400 instead of a silent 1h phantom', async () => {
    const r = await postMessage({ from: 'localboss', to: 'federation:teodor:teodor', content: 'hi' })
    expect(r.statusCode).toBe(400)
    expect(r.json.error).toMatch(/slash/i)
  })

  it('still accepts a normal local recipient and a valid qualified one', async () => {
    expect((await postMessage({ from: 'localboss', to: 'localmate', content: 'hi' })).statusCode).toBe(200)
    expect((await postMessage({ from: 'localboss', to: 'teodor/kutato', content: 'hi' })).statusCode).toBe(200)
  })
})

describe('delegation failure feedback (L5)', () => {
  it('bounces an ABANDONED federated task back to the sender as a local system notice', async () => {
    // Age it well past the 60-min default abandon window; the abandon branch
    // fires with NO network attempt.
    const old = createAgentMessage('localboss', 'teodor/kutato', 'please research X')
    const now = old.created_at * 1000 + 2 * 60 * 60 * 1000 // +2h
    await deliverFederatedBatch([getAgentMessage(old.id)!], now)

    expect(getAgentMessage(old.id)?.status).toBe('failed')
    // A single local 'system' notice now waits for the sender.
    const inbox = getPendingMessages('localboss')
    expect(inbox).toHaveLength(1)
    expect(inbox[0].from_agent).toBe('system')
    expect(inbox[0].to_agent).toBe('localboss') // local -- never crosses the bridge
    expect(inbox[0].content).toContain(`#${old.id}`)
    expect(inbox[0].content).toContain('teodor/kutato')
  })

  it('does NOT bounce a second notice when the row was already closed concurrently (status-guarded)', async () => {
    // Distinct sender: the in-memory DB is shared across tests (no per-test reset).
    const old = createAgentMessage('boss2', 'teodor/kutato', 'research Y')
    const now = old.created_at * 1000 + 2 * 60 * 60 * 1000
    // First pass: abandons + one notice.
    await deliverFederatedBatch([getAgentMessage(old.id)!], now)
    expect(getPendingMessages('boss2')).toHaveLength(1)
    // Second pass over the SAME (now failed) row: markPendingFederatedFailed
    // must not re-fire, so no duplicate notice piles up.
    await deliverFederatedBatch([getAgentMessage(old.id)!], now + 1000)
    expect(getPendingMessages('boss2')).toHaveLength(1) // still exactly one notice
  })
})
