import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase, createAgentMessage, getAgentMessage, markMessageDelivered, markMessageDone } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import {
  parseFederatedReceipt,
  applyFederatedReceipt,
  tryHandleFederation,
  _resetInboxDedupForTest,
} from '../web/routes/federation.js'
import { _setFederationStoreDirForTest, reloadFederationForTest } from '../web/federation/config.js'
import type { RouteContext } from '../web/routes/types.js'

const TMP = mkdtempSync(join(tmpdir(), 'fed-receipt-close-test-'))
const IN_TOKEN = 'b'.repeat(64)
const OUT_TOKEN = 'c'.repeat(64)

function writeEnabledConfigFile(): void {
  writeFileSync(join(TMP, 'federation.json'), JSON.stringify({
    enabled: true,
    systemId: 'localsys',
    peers: [
      { id: 'teodor', baseUrl: 'https://mini.example', outboundToken: OUT_TOKEN, inboundToken: IN_TOKEN },
      { id: 'other', baseUrl: 'https://other.example', outboundToken: 'd'.repeat(64), inboundToken: 'e'.repeat(64) },
    ],
  }))
  reloadFederationForTest()
}

function fakeCtx(method: string, path: string, body: string, fedPeer: string | null): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* not used */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(body))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer }, res: state }
}

/** A row we sent to a peer, as the bridge leaves it after a successful hand-off. */
function sentTo(to: string, from = MAIN_AGENT_ID): number {
  const m = createAgentMessage(from, to, 'feladat')
  markMessageDelivered(m.id)
  return m.id
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

describe('parseFederatedReceipt', () => {
  it('reads the header the receipt builder writes, and the body after the blank line', () => {
    expect(parseFederatedReceipt('[Eredmény] msg_id:773 status:done\n\nproba-ok, 1969: benne van'))
      .toEqual({ id: 773, status: 'done', result: 'proba-ok, 1969: benne van' })
    expect(parseFederatedReceipt('[Eredmény] msg_id:5 status:failed\n\nnem ment'))
      .toEqual({ id: 5, status: 'failed', result: 'nem ment' })
  })

  it('refuses anything that is not exactly that header', () => {
    expect(parseFederatedReceipt('hello')).toBeNull()
    expect(parseFederatedReceipt('[Eredmény] msg_id:ismeretlen status:done (nálunk msg 9)\n\nx')).toBeNull()
    expect(parseFederatedReceipt('[Eredmény] msg_id:7 status:pending\n\nx')).toBeNull()
    expect(parseFederatedReceipt('[Eredmény] msg_id:7 status:done extra\n\nx')).toBeNull()
    expect(parseFederatedReceipt('[Eredmény] msg_id:0 status:done\n\nx')).toBeNull()
    expect(parseFederatedReceipt('x [Eredmény] msg_id:7 status:done\n\nx')).toBeNull()
  })
})

describe('applyFederatedReceipt (DB guard)', () => {
  it('closes our open row sent to THAT peer, with the result', () => {
    writeEnabledConfigFile()
    const id = sentTo('teodor/teodor')
    expect(applyFederatedReceipt('teodor', `[Eredmény] msg_id:${id} status:done\n\nkész`)).toBe(id)
    const row = getAgentMessage(id)!
    expect(row.status).toBe('done')
    expect(row.result).toBe('kész')
    expect(row.completed_at).not.toBeNull()
  })

  it('a failed receipt marks the row failed', () => {
    const id = sentTo('teodor/teodor')
    expect(applyFederatedReceipt('teodor', `[Eredmény] msg_id:${id} status:failed\n\nhiba`)).toBe(id)
    expect(getAgentMessage(id)!.status).toBe('failed')
  })

  it('a peer cannot close a row we sent to ANOTHER peer, or a local row', () => {
    const toOther = sentTo('other/agent')
    const local = sentTo('marketing')
    expect(applyFederatedReceipt('teodor', `[Eredmény] msg_id:${toOther} status:done\n\nx`)).toBeNull()
    expect(applyFederatedReceipt('teodor', `[Eredmény] msg_id:${local} status:done\n\nx`)).toBeNull()
    expect(getAgentMessage(toOther)!.status).toBe('delivered')
    expect(getAgentMessage(local)!.status).toBe('delivered')
  })

  it('a peer-system prefix match is exact, not a substring (teodor vs teodorx)', () => {
    const id = sentTo('teodorx/agent')
    expect(applyFederatedReceipt('teodor', `[Eredmény] msg_id:${id} status:done\n\nx`)).toBeNull()
  })

  it('does not close a row a peer sent (relayed through us), nor an already closed row', () => {
    const relayed = sentTo('teodor/teodor', 'other/agent')
    expect(applyFederatedReceipt('teodor', `[Eredmény] msg_id:${relayed} status:done\n\nx`)).toBeNull()
    const closed = sentTo('teodor/teodor')
    markMessageDone(closed, 'első')
    expect(applyFederatedReceipt('teodor', `[Eredmény] msg_id:${closed} status:failed\n\nmásodik`)).toBeNull()
    expect(getAgentMessage(closed)!.result).toBe('első')
  })

  it('a dashboard-token caller (no peer) closes nothing', () => {
    const id = sentTo('teodor/teodor')
    expect(applyFederatedReceipt(null, `[Eredmény] msg_id:${id} status:done\n\nx`)).toBeNull()
    expect(getAgentMessage(id)!.status).toBe('delivered')
  })
})

describe('inbox endpoint: a receipt closes our outbound row and is still delivered', () => {
  it('202, the receipt row is created, and our row moves to done', async () => {
    writeEnabledConfigFile()
    const id = sentTo('teodor/teodor')
    const body = JSON.stringify({ from: 'teodor/teodor', to: MAIN_AGENT_ID, content: `[Eredmény] msg_id:${id} status:done\n\nproba-ok`, ref: '901' })
    const { ctx, res } = fakeCtx('POST', '/api/federation/inbox', body, 'teodor')
    await tryHandleFederation(ctx)
    expect(res.statusCode).toBe(202)
    const receiptId = JSON.parse(res.body).id as number
    expect(getAgentMessage(receiptId)!.content).toContain('proba-ok')
    expect(getAgentMessage(id)!.status).toBe('done')
    expect(getAgentMessage(id)!.result).toBe('proba-ok')
  })
})
