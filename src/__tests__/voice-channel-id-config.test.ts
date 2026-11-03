// VOICECHANNELID1022: the voice channel's sender id is VOICE_CHANNEL_ID from
// the install .env, 'hanna' when unset. Every place that keys on the id -- the
// channel-inbound framing, the device-key write guard, the delivery rank, the
// reserved-name list -- must follow the CONFIGURED value, and the old default
// must lose all of it once another id is configured.
//
// env.ts pins its .env directory at import time (CLAUDECLAW_ENV_DIR is its test
// seam), so each case re-imports the modules after pointing the seam at a
// temporary .env.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { resolveVoiceChannelId, DEFAULT_VOICE_CHANNEL_ID } from '../config.js'

const savedDir = process.env.CLAUDECLAW_ENV_DIR

async function loadWithEnvFile(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-id-env-'))
  writeFileSync(join(dir, '.env'), content)
  process.env.CLAUDECLAW_ENV_DIR = dir
  vi.resetModules()
  const { logger } = await import('../logger.js')
  const warn = vi.spyOn(logger, 'warn')
  const error = vi.spyOn(logger, 'error')
  const config = await import('../config.js')
  const ingest = await import('../channel-coordinator/ingest.js')
  const delivery = await import('../delivery-order.js')
  const wrap = await import('../web/agent-message-wrap.js')
  const messages = await import('../web/routes/messages.js')
  return { config, ingest, delivery, wrap, messages, warn, error }
}

async function postAs(
  tryHandleMessages: (ctx: any) => Promise<boolean>,
  from: string,
  auth?: { kind: string },
) {
  const req = Readable.from([Buffer.from(JSON.stringify({ from, to: 'marveen', content: 'a dictated line' }))]) as any
  let status = 0
  let body = ''
  const res = { writeHead(s: number) { status = s }, end(b?: string) { body = b ?? '' } } as any
  const handled = await tryHandleMessages({
    req, res, path: '/api/messages', method: 'POST', url: new URL('http://x/api/messages'), auth,
  } as any)
  expect(handled).toBe(true)
  return { status, body: body ? JSON.parse(body) : null }
}

afterAll(() => {
  if (savedDir === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = savedDir
  vi.restoreAllMocks()
  vi.resetModules()
})

const TAKEN = {
  mainAgentId: 'marveen',
  ownerName: 'Owner Person',
  systemSenderIds: 'cortex, @billing.',
  isSubAgent: (id: string) => id === 'atlas',
}

describe('resolveVoiceChannelId', () => {
  it('unset or blank keeps the default', () => {
    expect(resolveVoiceChannelId(undefined, TAKEN)).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID })
    expect(resolveVoiceChannelId('   ', TAKEN)).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID })
  })

  it('accepts a canonical agent id (trimmed)', () => {
    expect(resolveVoiceChannelId('voice-relay', TAKEN)).toEqual({ id: 'voice-relay' })
    expect(resolveVoiceChannelId(' relay2 ', TAKEN)).toEqual({ id: 'relay2' })
  })

  it('rejects a value the sanitizers would rewrite, so it could never match', () => {
    for (const bad of ['Voice', 'voice_relay', 'voice relay', '-voice', 'voice-', 'voice--relay', 'vóice', 'a/b', 'x'.repeat(51)]) {
      expect(resolveVoiceChannelId(bad, TAKEN), bad).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID, invalid: bad })
    }
  })

  it('rejects an id another sender uses: the message layer, a SYSTEM_SENDER_IDS entry, the main agent, a sub-agent', () => {
    for (const taken of ['system', 'heartbeat', 'telegram-coordinator', 'channel-coordinator', 'cortex', 'billing', 'marveen', 'atlas']) {
      expect(resolveVoiceChannelId(taken, TAKEN), taken).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID, invalid: taken })
    }
  })

  it("rejects the owner's name as the message route compares it", () => {
    expect(resolveVoiceChannelId('ownerperson', { ...TAKEN, ownerName: 'ownerperson' }))
      .toEqual({ id: DEFAULT_VOICE_CHANNEL_ID, invalid: 'ownerperson' })
    // The route's owner match is exact on the sanitized name, so a differently
    // cased owner name is a different sender and does not collide.
    expect(resolveVoiceChannelId('ownerperson', { ...TAKEN, ownerName: 'OwnerPerson' })).toEqual({ id: 'ownerperson' })
  })

  it('puts the default through the same checks: if it names another sender, the lane is off', () => {
    const d = DEFAULT_VOICE_CHANNEL_ID
    expect(resolveVoiceChannelId(undefined, { ...TAKEN, mainAgentId: d })).toEqual({ id: null, disabledBy: 'the main agent id' })
    expect(resolveVoiceChannelId(undefined, { ...TAKEN, ownerName: d })).toEqual({ id: null, disabledBy: "the owner's name" })
    expect(resolveVoiceChannelId(undefined, { ...TAKEN, systemSenderIds: `x,${d}` })).toEqual({ id: null, disabledBy: 'a SYSTEM_SENDER_IDS entry' })
    expect(resolveVoiceChannelId(undefined, { ...TAKEN, isSubAgent: (id) => id === d })).toEqual({ id: null, disabledBy: 'a sub-agent' })
    // An invalid value on top of it: both are reported.
    expect(resolveVoiceChannelId('Bad', { ...TAKEN, mainAgentId: d })).toEqual({ id: null, invalid: 'Bad', disabledBy: 'the main agent id' })
    // A free configured id is still taken, whatever the default collides with.
    expect(resolveVoiceChannelId('voice-relay', { ...TAKEN, mainAgentId: d })).toEqual({ id: 'voice-relay' })
  })
})

describe('VOICE_CHANNEL_ID set in .env to another valid id', () => {
  it('moves the voice handling and the reservation to that id, away from the default', async () => {
    const m = await loadWithEnvFile('VOICE_CHANNEL_ID=voice-relay\n')
    expect(m.config.VOICE_CHANNEL_ID).toBe('voice-relay')
    expect(m.config.VOICE_CHANNEL_ID_INVALID).toBeUndefined()
    expect(m.ingest.VOICE_CHANNEL_AGENT_ID).toBe('voice-relay')
    expect(m.delivery.voiceChannelSenderId()).toBe('voice-relay')

    // Reserved: the configured id, not the default.
    expect(m.config.RESERVED_AGENT_IDS).toContain('voice-relay')
    expect(m.config.RESERVED_AGENT_IDS).not.toContain(DEFAULT_VOICE_CHANNEL_ID)

    // Ranked as an owner channel: the configured id, not the default.
    expect(m.delivery.rankedSenders()).toContain('voice-relay')
    expect(m.delivery.rankedSenders()).not.toContain(DEFAULT_VOICE_CHANNEL_ID)

    // Framed as channel-inbound: the configured id, not the default.
    expect(m.wrap.classifyAgentMessage('voice-relay', 'marveen')!.category).toBe('channel-inbound')
    expect(m.wrap.classifyAgentMessage(DEFAULT_VOICE_CHANNEL_ID, 'marveen')!.category).not.toBe('channel-inbound')

    // Write guard: the configured id needs a device key ...
    const voice = await postAs(m.messages.tryHandleMessages, 'voice-relay', { kind: 'token' })
    expect(voice.status).toBe(403)
    expect(String(voice.body?.error)).toMatch(/device key/i)
    // ... and the default is now just an unknown sender, not the voice channel.
    const old = await postAs(m.messages.tryHandleMessages, DEFAULT_VOICE_CHANNEL_ID, { kind: 'token' })
    expect(old.status).toBe(403)
    expect(String(old.body?.error)).not.toMatch(/device key/i)
    expect(String(old.body?.error)).toMatch(/unknown agent/i)

    expect(m.warn.mock.calls.some(c => String(c[1] ?? '').includes('VOICE_CHANNEL_ID'))).toBe(false)
  })
})

describe('VOICE_CHANNEL_ID set in .env to an invalid value', () => {
  it('falls back to the default, reports the rejected value, and logs a warning', async () => {
    const m = await loadWithEnvFile('VOICE_CHANNEL_ID=Voice_Relay\n')
    expect(m.config.VOICE_CHANNEL_ID).toBe(DEFAULT_VOICE_CHANNEL_ID)
    expect(m.config.VOICE_CHANNEL_ID_INVALID).toBe('Voice_Relay')
    expect(m.ingest.VOICE_CHANNEL_AGENT_ID).toBe(DEFAULT_VOICE_CHANNEL_ID)
    expect(m.config.RESERVED_AGENT_IDS).toContain(DEFAULT_VOICE_CHANNEL_ID)
    expect(m.wrap.classifyAgentMessage(DEFAULT_VOICE_CHANNEL_ID, 'marveen')!.category).toBe('channel-inbound')
    const warned = m.warn.mock.calls.find(c => String(c[1] ?? '').includes('VOICE_CHANNEL_ID'))
    expect(warned).toBeDefined()
    expect(warned![0]).toMatchObject({ rejected: 'Voice_Relay', using: DEFAULT_VOICE_CHANNEL_ID })
  })

  it('the main agent id is refused too, so the main agent keeps its send lane', async () => {
    const m = await loadWithEnvFile('MAIN_AGENT_ID=atlas\nVOICE_CHANNEL_ID=atlas\n')
    expect(m.config.MAIN_AGENT_ID).toBe('atlas')
    expect(m.config.VOICE_CHANNEL_ID).toBe(DEFAULT_VOICE_CHANNEL_ID)
    expect(m.config.VOICE_CHANNEL_ID_INVALID).toBe('atlas')
  })
})

describe('the default names another sender', () => {
  it('switches the voice lane off, loudly, instead of shadowing that sender', async () => {
    const d = DEFAULT_VOICE_CHANNEL_ID
    const m = await loadWithEnvFile(`MAIN_AGENT_ID=${d}\n`)
    expect(m.config.VOICE_CHANNEL_ID).toBeNull()
    expect(m.config.VOICE_CHANNEL_DISABLED_BY).toBe('the main agent id')
    expect(m.ingest.VOICE_CHANNEL_AGENT_ID).toBeNull()
    expect(m.delivery.voiceChannelSenderId()).toBeNull()
    expect(m.config.RESERVED_AGENT_IDS).not.toContain(d)
    expect(m.delivery.rankedSenders()).not.toContain(null)
    // The main agent keeps its own lane: no voice framing, no device-key demand.
    expect(m.wrap.classifyAgentMessage(d, 'someone')!.category).not.toBe('channel-inbound')
    const r = await postAs(m.messages.tryHandleMessages, d, { kind: 'token' })
    expect(String(r.body?.error ?? '')).not.toMatch(/device key/i)
    const logged = m.error.mock.calls.find(c => String(c[1] ?? '').includes('voice channel lane is OFF'))
    expect(logged).toBeDefined()
    expect(logged![0]).toMatchObject({ default: d, collidesWith: 'the main agent id' })
  })
})

describe('VOICE_CHANNEL_ID unset', () => {
  it('keeps the historical id, so an existing relay keeps working unchanged', async () => {
    const m = await loadWithEnvFile('OWNER_NAME=Someone\n')
    expect(m.config.VOICE_CHANNEL_ID).toBe('hanna')
    expect(m.config.VOICE_CHANNEL_ID_INVALID).toBeUndefined()
    expect(m.config.RESERVED_AGENT_IDS).toContain('hanna')
    expect(m.delivery.rankedSenders()).toContain('hanna')
  })
})
