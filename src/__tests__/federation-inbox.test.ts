import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, getPendingMessages } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import {
  validateInboxPayload,
  tryHandleFederation,
  _resetInboxDedupForTest,
  purgeInboxDedup,
  INBOX_MAX_BODY_BYTES,
} from '../web/routes/federation.js'
import {
  _setFederationStoreDirForTest,
  reloadFederationForTest,
  type FederationConfig,
} from '../web/federation/config.js'
import type { RouteContext } from '../web/routes/types.js'

const TMP = mkdtempSync(join(tmpdir(), 'fed-inbox-test-'))
const IN_TOKEN = 'b'.repeat(64)
const OUT_TOKEN = 'c'.repeat(64)

const CFG: FederationConfig = {
  enabled: true,
  systemId: 'arthur',
  peers: [{ id: 'teodor', baseUrl: 'https://mini.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, trust: 'untrusted' }],
}

const DEPS = { isKnownAgent: (n: string) => n === 'marketing', mainAgentId: 'arthur' }

function writeEnabledConfigFile(): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
    enabled: true,
    systemId: 'localsys',
    peers: [{ id: 'teodor', baseUrl: 'https://mini.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN }],
  }))
  reloadFederationForTest()
}

// Minimal req/res doubles for the tryHandleFederation HTTP surface. readBody
// consumes data/end events; json() uses writeHead/end.
function fakeCtx(method: string, path: string, body?: string, fedPeer: string | null = null): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  if (body !== undefined) {
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(body))
      ;(req as unknown as EventEmitter).emit('end')
    })
  }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer }, res: state }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  rmSync(join(TMP, 'federation.json'), { force: true })
  _setFederationStoreDirForTest(TMP)
  _resetInboxDedupForTest()
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('validateInboxPayload (pure validation matrix)', () => {
  const good = { from: 'teodor/teodor', to: 'marketing', content: 'hello', ref: '12' }

  it('accepts a well-formed payload from the matching authenticated peer', () => {
    expect(validateInboxPayload(good, CFG, DEPS, 'teodor')).toEqual({ from: 'teodor/teodor', to: 'marketing', content: 'hello', ref: '12' })
  })

  it('REJECTS a claimed sender that differs from the authenticated peer (impersonation guard)', () => {
    const cfgTwoPeers: FederationConfig = {
      ...CFG,
      peers: [...CFG.peers, { id: 'cecil', baseUrl: 'https://c.example', outboundToken: OUT_TOKEN, inboundToken: 'd'.repeat(64), trust: 'untrusted' }],
    }
    // cecil's token authenticated the call, but the payload claims teodor:
    expect(validateInboxPayload(good, cfgTwoPeers, DEPS, 'cecil')).toMatchObject({ status: 403 })
  })

  it('dashboard-token caller (null) may claim any CONFIGURED peer, nothing else', () => {
    expect(validateInboxPayload(good, CFG, DEPS, null)).toMatchObject({ from: 'teodor/teodor' })
    expect(validateInboxPayload({ ...good, from: 'stranger/x' }, CFG, DEPS, null)).toMatchObject({ status: 403 })
  })

  it('rejects malformed from, self-system from, qualified to, unknown recipient', () => {
    expect(validateInboxPayload({ ...good, from: 'unqualified' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ ...good, from: 'a/b/c' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ ...good, from: 'arthur/x' }, CFG, DEPS, null)).toMatchObject({ status: 403 })
    expect(validateInboxPayload({ ...good, to: 'other/agent' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 403 })
    expect(validateInboxPayload({ ...good, to: 'nobody' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 404 })
  })

  it('matches the from system case-insensitively and STORES it lowercase; agent case preserved (L1)', () => {
    expect(validateInboxPayload({ ...good, from: 'Teodor/Boti' }, CFG, DEPS, 'teodor'))
      .toMatchObject({ from: 'teodor/Boti' })
    // Dashboard caller path uses the same folding against the configured list.
    expect(validateInboxPayload({ ...good, from: 'TEODOR/x' }, CFG, DEPS, null)).toMatchObject({ from: 'teodor/x' })
    // Self-system guard is case-insensitive too.
    expect(validateInboxPayload({ ...good, from: 'Arthur/x' }, CFG, DEPS, null)).toMatchObject({ status: 403 })
  })

  it('accepts the main agent as recipient; rejects empty content and oversized ref', () => {
    expect(validateInboxPayload({ from: 'teodor/x', to: 'arthur', content: 'hi' }, CFG, DEPS, 'teodor')).toMatchObject({ to: 'arthur', ref: null })
    expect(validateInboxPayload({ ...good, content: '  ' }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
    expect(validateInboxPayload({ ...good, ref: 'r'.repeat(129) }, CFG, DEPS, 'teodor')).toMatchObject({ status: 400 })
  })
})

describe('tryHandleFederation -- inbox endpoint (HTTP + DB)', () => {
  it('403s when federation is disabled', async () => {
    const { ctx, res } = fakeCtx('POST', '/api/federation/inbox', '{}', 'teodor')
    expect(await tryHandleFederation(ctx)).toBe(true)
    expect(res.statusCode).toBe(403)
  })

  it('accepts a valid message: 202, pending row with the qualified from, content verbatim', async () => {
    writeEnabledConfigFile()
    const content = 'see card #ab12cd34 please' // kanban-ref shape must survive verbatim
    const payload = JSON.stringify({ from: 'teodor/teodor', to: MAIN_AGENT_ID, content, ref: '55' })
    const { ctx, res } = fakeCtx('POST', '/api/federation/inbox', payload, 'teodor')
    expect(await tryHandleFederation(ctx)).toBe(true)
    expect(res.statusCode).toBe(202)
    const { id } = JSON.parse(res.body)
    const row = getPendingMessages(MAIN_AGENT_ID).find((m) => m.id === id)
    expect(row?.from_agent).toBe('teodor/teodor')
    expect(row?.content).toBe(content)
  })

  it('dedup applies to peer-authenticated callers ONLY (dashboard cannot poison a peer key)', async () => {
    writeEnabledConfigFile()
    const payload = JSON.stringify({ from: 'teodor/teodor', to: MAIN_AGENT_ID, content: 'dup test', ref: 'dup-1' })

    // Dashboard-token caller (fedPeer null) inserts but must NOT seed dedup:
    const dash = fakeCtx('POST', '/api/federation/inbox', payload, null)
    await tryHandleFederation(dash.ctx)
    expect(dash.res.statusCode).toBe(202)
    expect(JSON.parse(dash.res.body).duplicate).toBeUndefined()

    // The REAL peer sending the same ref must be a fresh insert, not a
    // replayed ack of the dashboard's row:
    const first = fakeCtx('POST', '/api/federation/inbox', payload, 'teodor')
    await tryHandleFederation(first.ctx)
    expect(first.res.statusCode).toBe(202)
    expect(JSON.parse(first.res.body).duplicate).toBeUndefined()
    const firstId = JSON.parse(first.res.body).id

    // Peer replay of the same ref -> duplicate ack, no new row:
    const before = getPendingMessages(MAIN_AGENT_ID).length
    const second = fakeCtx('POST', '/api/federation/inbox', payload, 'teodor')
    await tryHandleFederation(second.ctx)
    expect(JSON.parse(second.res.body)).toMatchObject({ id: firstId, duplicate: true })
    expect(getPendingMessages(MAIN_AGENT_ID).length).toBe(before)

    // Purging the peer's dedup entries makes the ref fresh again:
    purgeInboxDedup('teodor')
    const third = fakeCtx('POST', '/api/federation/inbox', payload, 'teodor')
    await tryHandleFederation(third.ctx)
    expect(JSON.parse(third.res.body).duplicate).toBeUndefined()
  })

  it('413s an oversized body (Content-Length precheck) instead of a retryable-looking failure', async () => {
    writeEnabledConfigFile()
    const { ctx, res } = fakeCtx('POST', '/api/federation/inbox', undefined, 'teodor')
    ;(ctx.req.headers as Record<string, string>)['content-length'] = String(INBOX_MAX_BODY_BYTES + 1)
    expect(await tryHandleFederation(ctx)).toBe(true)
    expect(res.statusCode).toBe(413)
  })
})

describe('tryHandleFederation -- manifest + peers view', () => {
  it('manifest 403s when disabled; reports system/version/agents when enabled; no operator-private data', async () => {
    const denied = fakeCtx('GET', '/api/federation/manifest')
    await tryHandleFederation(denied.ctx)
    expect(denied.res.statusCode).toBe(403)

    writeEnabledConfigFile()
    const { ctx, res } = fakeCtx('GET', '/api/federation/manifest')
    await tryHandleFederation(ctx)
    expect(res.statusCode).toBe(200)
    const manifest = JSON.parse(res.body)
    expect(manifest.system).toBe('localsys')
    expect(manifest.federationVersion).toBe(1)
    expect(manifest.agents.some((a: { id: string }) => a.id === MAIN_AGENT_ID)).toBe(true)
    expect(res.body).not.toContain('remoteHost')
    expect(res.body).not.toContain('securityProfile')
  })

  it('capabilitySummary in the manifest is per-peer opt-in AND dashboard-token visible (L5)', async () => {
    const { _setCapabilityStoreDirForTest, writeCapabilityCache } = await import('../web/federation/capabilities.js')
    _setCapabilityStoreDirForTest(TMP)
    // Two peers: only 'sharer' has the flag.
    writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
      enabled: true, systemId: 'localsys',
      peers: [
        { id: 'sharer', baseUrl: 'https://s.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN, shareCapabilitySummaries: true },
        { id: 'lurker', baseUrl: 'https://l.example', outboundToken: OUT_TOKEN, inboundToken: 'd'.repeat(64) },
      ],
    }))
    reloadFederationForTest()
    writeCapabilityCache({})

    async function manifestAs(fedPeer: string | null): Promise<{ agents: Array<{ id: string; capabilitySummary?: string }> }> {
      const { ctx, res } = fakeCtx('GET', '/api/federation/manifest', undefined, fedPeer)
      await tryHandleFederation(ctx)
      return JSON.parse(res.body)
    }
    // The main agent's fixed summary is enough to prove per-caller gating
    // (no sub-agents exist in this in-memory test).
    const mainOf = (m: { agents: Array<{ id: string; capabilitySummary?: string }> }) => m.agents.find((a) => a.id === MAIN_AGENT_ID)
    expect(mainOf(await manifestAs('sharer'))?.capabilitySummary).toBeTruthy()
    expect(mainOf(await manifestAs('lurker'))?.capabilitySummary).toBeUndefined() // not flagged -> no summary
    expect(mainOf(await manifestAs(null))?.capabilitySummary).toBeTruthy()        // dashboard token: never leaves the box
  })

  it('peers view NEVER contains tokens -- presence flags only', async () => {
    writeEnabledConfigFile()
    const { ctx, res } = fakeCtx('GET', '/api/federation/peers')
    await tryHandleFederation(ctx)
    const view = JSON.parse(res.body)
    expect(view.peers[0]).toMatchObject({ id: 'teodor', hasOutboundToken: true, hasInboundToken: true })
    expect(res.body).not.toContain(IN_TOKEN)
    expect(res.body).not.toContain(OUT_TOKEN)
  })
})
