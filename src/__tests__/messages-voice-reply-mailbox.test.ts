import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getAgentMessage, getPendingMessages, getAgentConversation } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages, VOICE_MAILBOX_RESULT } from '../web/routes/messages.js'
import { VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import type { RouteContext } from '../web/routes/types.js'

// VOICEREPLY1005: the answer to a voice-channel message goes back to the voice
// channel id as a PULL MAILBOX. Since UNKNOWNTO924 every such answer got 400
// "unknown recipient" (measured 2026-10-05): the voice id is not a registered
// agent. It must be accepted, never handed to the router (no session owns it,
// so delivery would fail and raise a [handoff-failure] for every answer), and
// stay readable in the sender's conversation, where the relay reads it.

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null, auth: { kind: 'token' } }, res: state }
}

async function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body)
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('POST /api/messages to the voice channel mailbox (VOICEREPLY1005)', () => {
  it('is accepted, stored as done (never pending), and marked as a mailbox row', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: VOICE_CHANNEL_AGENT_ID, content: '[VALASZ A HANGCSATORNARA]: kesz' })
    expect(r.statusCode).toBe(200)
    expect(r.json.mailbox).toBe(true)
    const id = r.json.id as number
    const row = getAgentMessage(id)!
    expect(row.to_agent).toBe(VOICE_CHANNEL_AGENT_ID)
    expect(row.status).toBe('done')
    expect(row.result).toBe(VOICE_MAILBOX_RESULT)
    expect(getPendingMessages().some(m => m.id === id)).toBe(false)
  })

  it("is readable in the sender's conversation, where the relay reads it", async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: VOICE_CHANNEL_AGENT_ID, content: '[VALASZ A HANGCSATORNARA]: masodik' })
    const conv = getAgentConversation(MAIN_AGENT_ID, 50)
    expect(conv.some(m => m.id === r.json.id && m.to_agent === VOICE_CHANNEL_AGENT_ID)).toBe(true)
  })

  it('carries no "stopped agent" warning (there is no agent to run)', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: VOICE_CHANNEL_AGENT_ID, content: 'x' })
    expect(r.json.warning).toBeUndefined()
    expect(r.json.targetRunning).toBeUndefined()
  })

  it('every other unregistered recipient is still rejected (UNKNOWNTO924 unchanged)', async () => {
    for (const to of ['PLACEHOLDER', 'szabolcs', `${VOICE_CHANNEL_AGENT_ID}x`]) {
      const r = await post({ from: MAIN_AGENT_ID, to, content: 'x' })
      expect(r.statusCode).toBe(400)
      expect(String(r.json.error)).toMatch(/unknown recipient/)
    }
  })
})
