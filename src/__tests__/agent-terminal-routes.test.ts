import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(true),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  resolveFromPath: vi.fn().mockReturnValue('/usr/bin/tmux'),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  agentDir: vi.fn().mockReturnValue('/tmp/agent-a-dir'),
  agentSessionName: vi.fn().mockReturnValue('agent-a-session'),
  isAgentRunning: vi.fn().mockReturnValue(true),
  isMainChannelsAgent: vi.fn().mockReturnValue(false),
  MAIN_CHANNELS_SESSION: 'test-channels',
  readTerminalInputEnabled: vi.fn().mockReturnValue(true),
  writeTerminalInputEnabled: vi.fn().mockImplementation((v: boolean) => v),
  literalKeyArgs: vi.fn().mockReturnValue(['send-keys', '-t', 'session', 'text']),
  specialKeyArgs: vi.fn().mockReturnValue(null),
  loginSequence: vi.fn().mockReturnValue([]),
}))

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return { ...orig, existsSync: mocks.existsSync }
})
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execFile: mocks.execFile, execFileSync: mocks.execFileSync }
})
vi.mock('../../platform.js', () => ({ resolveFromPath: mocks.resolveFromPath }))
vi.mock('../../logger.js', () => ({ logger: mocks.logger }))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...orig, agentDir: mocks.agentDir }
})
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-process.js')>()
  return { ...orig, agentSessionName: mocks.agentSessionName, isAgentRunning: mocks.isAgentRunning }
})
vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: mocks.isMainChannelsAgent,
  MAIN_CHANNELS_SESSION: mocks.MAIN_CHANNELS_SESSION,
}))
vi.mock('../web/terminal-input-store.js', () => ({
  readTerminalInputEnabled: mocks.readTerminalInputEnabled,
  writeTerminalInputEnabled: mocks.writeTerminalInputEnabled,
}))
vi.mock('../web/tmux-keys.js', () => ({
  literalKeyArgs: mocks.literalKeyArgs,
  specialKeyArgs: mocks.specialKeyArgs,
  loginSequence: mocks.loginSequence,
}))

import { tryHandleAgentTerminal } from '../web/routes/agent-terminal.js'

function makeCtx(opts: { method: string; path: string; body?: string | object }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const em = new EventEmitter() as any
  em.headers = {}
  em.socket = { remoteAddress: '127.0.0.1' }
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number, _h?: object) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
    write: vi.fn(),
    on: vi.fn(),
  }
  const url = new URL(`http://localhost${opts.path}`)
  const ctx: RouteContext = {
    req: em as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method: opts.method,
    url,
    auth: { kind: 'token' },
  }
  return { ctx, status: () => code, body: () => { try { return JSON.parse(resBody) } catch { return resBody } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.existsSync.mockReturnValue(true)
  mocks.isAgentRunning.mockReturnValue(true)
  mocks.isMainChannelsAgent.mockReturnValue(false)
  mocks.readTerminalInputEnabled.mockReturnValue(true)
  mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'session', 'text'])
  mocks.specialKeyArgs.mockReturnValue(null)
  mocks.loginSequence.mockReturnValue([])
})

describe('agent-terminal routes -- error normalization (B11a)', () => {

  describe('POST /api/terminal-input -- toggle', () => {
    it('parse_error on invalid JSON body', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/terminal-input', body: 'not-json' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      expect((body() as any).error).toBe('parse_error')
    })

    it('invalid_value + field:enabled when body.enabled is not boolean', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/terminal-input', body: { enabled: 'yes' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      const b = body() as any
      expect(b.error).toBe('invalid_value')
      expect(b.field).toBe('enabled')
    })
  })

  describe('GET pane stream', () => {
    it('not_found + 404 when agent does not exist', async () => {
      mocks.existsSync.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/agents/agent-a/pane/stream' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(404)
      expect((body() as any).error).toBe('not_found')
    })
  })

  describe('POST /api/agents/:name/keys', () => {
    it('forbidden + 403 when terminal-input disabled', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(403)
      expect((body() as any).error).toBe('forbidden')
    })

    it('not_found + 404 when agent does not exist', async () => {
      mocks.existsSync.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(404)
      expect((body() as any).error).toBe('not_found')
    })

    it('conflict + 409 when agent exists but is not running', async () => {
      mocks.isAgentRunning.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(409)
      const b = body() as any
      expect(b.error).toBe('conflict')
      expect(b.hint).toBeTruthy()
    })

    it('parse_error on invalid JSON body', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: 'not-json' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      expect((body() as any).error).toBe('parse_error')
    })

    it('invalid_value when payload has neither keys nor special', async () => {
      mocks.literalKeyArgs.mockReturnValue(null)
      mocks.specialKeyArgs.mockReturnValue(null)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { other: 'field' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      expect((body() as any).error).toBe('invalid_value')
    })

    it('internal_error + 500 when tmux send-keys fails', async () => {
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
        cb(new Error('tmux died'))
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'hello' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(500)
      expect((body() as any).error).toBe('internal_error')
    })
  })

  describe('POST /api/agents/:name/login', () => {
    it('not_found + 404 when agent does not exist', async () => {
      mocks.existsSync.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(404)
      expect((body() as any).error).toBe('not_found')
    })

    it('conflict + 409 when agent exists but is not running', async () => {
      mocks.isAgentRunning.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(409)
      const b = body() as any
      expect(b.error).toBe('conflict')
      expect(b.hint).toBeTruthy()
    })

    it('invalid_value + field:phase for unknown phase value', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'unknown' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      const b = body() as any
      expect(b.error).toBe('invalid_value')
      expect(b.field).toBe('phase')
    })

    it('internal_error + 500 when login sequence fails', async () => {
      mocks.loginSequence.mockReturnValue([{ kind: 'literal', text: 'x', delayMs: 0 }])
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 's', 'x'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
        cb(new Error('tmux died'))
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(500)
      expect((body() as any).error).toBe('internal_error')
    })
  })

})
