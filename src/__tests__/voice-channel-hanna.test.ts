import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { classifyAgentMessage } from '../web/agent-message-wrap.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import { tryHandleMessages } from '../web/routes/messages.js'

// HANGCSATORNA918 (owner request, 2026-09-18). The owner dictates into an
// external voice assistant which relays the transcript to /api/messages. Before
// this, the relay wrote as the MAIN AGENT, so the message arrived looking like
// the main agent talking to itself and no receiving agent could tell it apart
// from internal fleet traffic.
//
// The fix has TWO halves and they only work together:
//   1. delivery side: 'hanna' is in CHANNEL_COORDINATOR_AGENTS -> channel-inbound
//      framing, so EVERY agent sees the provenance, not just the main agent;
//   2. write side: a 'hanna' POST is accepted only from an enrolled DEVICE KEY.
// Half 1 alone would be a forgery hole: channel-inbound means "the owner, reply
// expected", and the dashboard token is readable by every sub-agent.

const here = dirname(fileURLToPath(import.meta.url))
const MESSAGES_ROUTE_SRC = readFileSync(join(here, '../web/routes/messages.ts'), 'utf-8')

describe('voice channel identity', () => {
  it('has its own id, distinct from the main agent and the telegram coordinator', () => {
    expect(VOICE_CHANNEL_AGENT_ID).toBe('hanna')
    expect(VOICE_CHANNEL_AGENT_ID).not.toBe(COORDINATOR_AGENT_ID)
  })

  it('classifies as channel-inbound, so every receiving agent sees the provenance', () => {
    const cls = classifyAgentMessage(VOICE_CHANNEL_AGENT_ID, 'marveen')
    expect(cls).not.toBeNull()
    expect(cls!.category).toBe('channel-inbound')
    expect(cls!.safeFrom).toBe(VOICE_CHANNEL_AGENT_ID)
  })

  it('a sub-agent recipient sees the SAME category (the framing is not main-agent-only)', () => {
    for (const to of ['mira', 'samu', 'iris']) {
      expect(classifyAgentMessage(VOICE_CHANNEL_AGENT_ID, to)!.category).toBe('channel-inbound')
    }
  })
})

describe('/api/messages write guard for the voice channel', () => {
  async function postAs(from: string, auth?: { kind: string; device?: string; deviceId?: number }) {
    const payload = JSON.stringify({ from, to: 'marveen', content: 'a dictated line' })
    const req = Readable.from([Buffer.from(payload)]) as any
    let status = 0
    let body = ''
    const res = {
      writeHead(s: number) { status = s },
      end(b?: string) { body = b ?? '' },
    } as any
    const handled = await tryHandleMessages({
      req, res, path: '/api/messages', method: 'POST',
      url: new URL('http://x/api/messages'), auth,
    } as any)
    expect(handled).toBe(true)
    return { status, body: body ? JSON.parse(body) : null }
  }

  it('REJECTS the voice-channel id on the shared dashboard token (the forgery path)', async () => {
    const { status, body } = await postAs(VOICE_CHANNEL_AGENT_ID, { kind: 'token' })
    expect(status).toBe(403)
    expect(String(body?.error)).toMatch(/device key/i)
  })

  it('REJECTS it with no credential at all', async () => {
    const { status } = await postAs(VOICE_CHANNEL_AGENT_ID)
    expect(status).toBe(403)
  })

  it('REJECTS a browser session too -- a logged-in human is still not the relay', async () => {
    const { status } = await postAs(VOICE_CHANNEL_AGENT_ID, { kind: 'session' })
    expect(status).toBe(403)
  })

  it('rejects the sanitize-bypass spellings on the same lane (router-symmetric)', async () => {
    for (const forged of ['@hanna', 'hanna.', ' hanna ', 'hanna!']) {
      const { status } = await postAs(forged, { kind: 'token' })
      expect(status, `forged from=${JSON.stringify(forged)} must be blocked`).toBe(403)
    }
  })

  it('PASSES both guards on the device lane (it has no agents/<id>/ dir either)', async () => {
    // Two guards could refuse this: the device-key lane check, and the
    // known-agent check (the voice id has no agents/<id>/ directory, so it
    // needs an explicit exemption). Passing BOTH means the handler runs on to
    // the insert -- which throws here because this harness has no DB. That
    // throw is the PROOF of passage, so we assert on it rather than skipping:
    // a guard rejection would have returned a 403 instead of ever reaching db.
    await expect(
      postAs(VOICE_CHANNEL_AGENT_ID, { kind: 'device', device: 'a-device', deviceId: 5 }),
    ).rejects.toThrow(/prepare/)
  })

  it('NEGATIVE CONTROL: an unknown non-voice id is refused by the known-agent guard', async () => {
    // Without this the test above proves nothing: it would pass even if the
    // handler let EVERY sender through to the insert.
    const { status, body } = await postAs('zack-the-stranger', { kind: 'device', device: 'a-device', deviceId: 5 })
    expect(status).toBe(403)
    expect(String(body?.error)).toMatch(/unknown agent/i)
  })
})

describe('the two halves stay paired in the source', () => {
  it('the route guards the voice id on the AUTH LANE, not with a blanket 403', () => {
    expect(MESSAGES_ROUTE_SRC).toMatch(/sanitizeAgentIdent\(from\)\s*===\s*VOICE_CHANNEL_AGENT_ID\s*&&\s*ctx\.auth\?\.kind\s*!==\s*'device'/)
  })

  it('the id comes from the shared constant, never a literal in the route', () => {
    expect(MESSAGES_ROUTE_SRC).toMatch(/import \{ COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID \}/)
    // The id must not appear as a bare literal anywhere in the route, not even
    // in a comment: a future reader copying the comment would fork the source of truth.
    expect(MESSAGES_ROUTE_SRC).not.toMatch(/['\"`]hanna['\"`]/)
  })
})
