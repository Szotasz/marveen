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
  const config = await import('../config.js')
  const ingest = await import('../channel-coordinator/ingest.js')
  const delivery = await import('../delivery-order.js')
  const wrap = await import('../web/agent-message-wrap.js')
  const messages = await import('../web/routes/messages.js')
  return { config, ingest, delivery, wrap, messages, warn }
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

describe('resolveVoiceChannelId', () => {
  it('unset or blank keeps the default', () => {
    expect(resolveVoiceChannelId(undefined)).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID })
    expect(resolveVoiceChannelId('   ')).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID })
  })

  it('accepts a canonical agent id (trimmed)', () => {
    expect(resolveVoiceChannelId('voice-relay')).toEqual({ id: 'voice-relay' })
    expect(resolveVoiceChannelId(' relay2 ')).toEqual({ id: 'relay2' })
  })

  it('rejects a value the sanitizers would rewrite, so it could never match', () => {
    for (const bad of ['Voice', 'voice_relay', 'voice relay', '-voice', 'voice-', 'voice--relay', 'vóice', 'a/b', 'x'.repeat(51)]) {
      expect(resolveVoiceChannelId(bad), bad).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID, invalid: bad })
    }
  })

  it('rejects an id the message layer owns', () => {
    for (const taken of ['system', 'heartbeat', 'telegram-coordinator', 'channel-coordinator']) {
      expect(resolveVoiceChannelId(taken), taken).toEqual({ id: DEFAULT_VOICE_CHANNEL_ID, invalid: taken })
    }
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
