// Error-shape tests for voice endpoints (#672 B14).
// Covers: parse_error and invalid_value branches on modality/set and stt.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
  AGENTS_BASE_DIR: '/tmp/mock-agents',
  MAIN_AGENT_ID: 'agent-a',
}))

vi.mock('../web/agent-config.js', () => ({
  KNOWN_VOICE_MODELS: new Set(['hu_HU-imre-medium']),
  AGENTS_BASE_DIR: '/tmp/mock-agents',
  readAgentVoiceConfig: vi.fn().mockReturnValue({ responseMode: 'text', voiceModel: null }),
}))

vi.mock('../web/voice-modality.js', () => ({
  getLastInboundModality: vi.fn().mockReturnValue('text'),
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/voice-directive.js', () => ({
  buildTtsDirective: vi.fn().mockReturnValue(null),
  resolveAgentChannelStateDir: vi.fn().mockReturnValue('/tmp/mock-state'),
  inboundIsAudio: vi.fn().mockReturnValue(false),
}))

// isVoiceInstalled() reads from the filesystem; mock node:fs so it returns
// a controlled value. We set it to true for the STT tests.
let mockVoiceInstalled = false
vi.mock('node:fs', () => ({
  existsSync: vi.fn((_p: string) => mockVoiceInstalled),
  readdirSync: vi.fn().mockReturnValue([]),
}))

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(method: string, path: string, bodyOrRaw?: object | string | null): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> }
} {
  const isRaw = typeof bodyOrRaw === 'string'
  const buf = bodyOrRaw == null
    ? Buffer.alloc(0)
    : isRaw
      ? Buffer.from(bodyOrRaw)
      : Buffer.from(JSON.stringify(bodyOrRaw))
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { method: string; headers: Record<string, string> }).method = method
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  setImmediate(() => {
    ;(req as unknown as EventEmitter).emit('data', buf)
    ;(req as unknown as EventEmitter).emit('end')
  })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      const str = b ? (Buffer.isBuffer(b) ? b.toString('utf-8') : b) : ''
      try { out.body = JSON.parse(str) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext,
    out,
  }
}

import { tryHandleVoice } from '../web/routes/voice.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockVoiceInstalled = false
})

// ── POST /api/voice/modality/set ──────────────────────────────────────────────

describe('POST /api/voice/modality/set -- error shapes', () => {
  it('returns parse_error + 400 for invalid JSON body', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/modality/set', 'not-json{{')
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('parse_error')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })

  it('returns invalid_value + agent_id + 400 for bad agent_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/modality/set', {
      agent_id: 'bad agent!',
      chat_id: '123456',
      modality: 'voice',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('agent_id')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })

  it('returns invalid_value + chat_id + 400 for non-numeric chat_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/modality/set', {
      agent_id: 'valid-agent',
      chat_id: 'not-a-number',
      modality: 'voice',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('chat_id')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })

  it('returns invalid_value + modality + 400 for unknown modality value', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/modality/set', {
      agent_id: 'valid-agent',
      chat_id: '123456',
      modality: 'telepathy',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('modality')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })
})

// ── POST /api/voice/stt ───────────────────────────────────────────────────────

describe('POST /api/voice/stt -- error shapes', () => {
  it('returns parse_error + 400 for invalid JSON body (voice installed)', async () => {
    mockVoiceInstalled = true
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', 'not-json{{')
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('parse_error')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })

  it('returns invalid_value + file_id + 400 for bad file_id (voice installed)', async () => {
    mockVoiceInstalled = true
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', {
      file_id: '../../etc/passwd',
      state_dir: '/tmp/valid-state',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('file_id')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })

  it('returns invalid_value + state_dir + 400 for unsafe state_dir (voice installed)', async () => {
    mockVoiceInstalled = true
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', {
      file_id: 'AgACAgQAAxkBAAI',   // matches SAFE_FILE_ID_RE
      state_dir: '/etc/something/bad',
    })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('state_dir')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })

  it('returns not_supported + 503 when voice toolkit is not installed', async () => {
    mockVoiceInstalled = false
    const { ctx, out } = makeCtx('POST', '/api/voice/stt', { file_id: 'AgACAgQAAxkBAAI', state_dir: '/tmp/st' })
    await tryHandleVoice(ctx)
    expect(out.status).toBe(503)
    expect(out.body.error).toBe('not_supported')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })
})

// ── Mutation verification ─────────────────────────────────────────────────────

describe('mutation: wrong error token would be caught', () => {
  it('test detects if parse_error were returned as parseError', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/modality/set', 'not-json{{')
    await tryHandleVoice(ctx)
    expect(out.body.error).not.toBe('parseError')
    expect(out.body.error).toBe('parse_error')
  })

  it('test detects if invalid_value were returned as invalidValue', async () => {
    const { ctx, out } = makeCtx('POST', '/api/voice/modality/set', {
      agent_id: 'bad agent!',
      chat_id: '123456',
      modality: 'voice',
    })
    await tryHandleVoice(ctx)
    expect(out.body.error).not.toBe('invalidValue')
    expect(out.body.error).toBe('invalid_value')
  })
})
