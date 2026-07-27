// Extended coverage for agents-channels routes: success paths, setup POST, teardown, pending.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { TEST_AGENT_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  const root = mkdtempSync(path.join(os.tmpdir(), 'channels-ext-'))
  const dir = path.join(root, 'test-agent')
  mkdirSync(dir, { recursive: true })
  return { TEST_AGENT_DIR: dir }
})

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockImplementation((name: string) => name === 'test-agent' ? TEST_AGENT_DIR : `/nonexistent/agents/${name}`),
    readFileOr: vi.fn().mockReturnValue(''),
    readAgentChannelProvider: vi.fn().mockReturnValue(null),
    writeAgentChannelProvider: vi.fn(),
    readAgentDisplayName: vi.fn().mockReturnValue('Test Agent'),
    readAgentRemoteHost: vi.fn().mockReturnValue(null),
  }
})
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    getProvider: vi.fn().mockReturnValue({
      validateToken: vi.fn().mockResolvedValue({ ok: false, error: 'invalid token' }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    }),
    channelStateDir: vi.fn().mockReturnValue('/tmp/ch-ext-state'),
    readChannelToken: vi.fn().mockReturnValue(null),
    generateSlackAppManifest: vi.fn().mockReturnValue({ name: 'test-app' }),
    getSlackAppSetupInstructions: vi.fn().mockReturnValue('instructions'),
  }
})
vi.mock('../web/channel-invites.js', () => ({
  createInvite: vi.fn().mockReturnValue({ token: 'tok123', expiresAt: 0 }),
  listInvites: vi.fn().mockReturnValue([]),
  revokeInvite: vi.fn().mockReturnValue(true),
}))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: vi.fn().mockReturnValue(false),
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))
vi.mock('../web/telegram.js', () => ({
  readAgentTelegramConfig: vi.fn().mockReturnValue({ botUsername: undefined }),
  readMarveenTelegramConfig: vi.fn().mockReturnValue({ botUsername: undefined }),
  sendWelcomeMessage: vi.fn().mockResolvedValue(undefined),
  parseTelegramToken: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: vi.fn().mockReturnValue(false),
  startAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  stopAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  agentSessionName: vi.fn().mockImplementation((n: string) => `agent-${n}`),
  sendPromptToSession: vi.fn().mockReturnValue({ ok: true }),
  capturePane: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: vi.fn().mockReturnValue({ ok: true, message: 'reconnected' }),
}))
vi.mock('../web/channel-health-monitor.js', () => ({
  getChannelHealth: vi.fn().mockReturnValue({ status: 'ok', provider: 'telegram' }),
}))
vi.mock('../web/routes/agents-helpers.js', () => ({
  matchChannelRoute: vi.fn().mockImplementation((path: string, suffix: string) => {
    const pattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`)
    const match = path.match(pattern)
    if (match) return [decodeURIComponent(match[1]), match[2]]
    return null
  }),
  resolveAccessPath: vi.fn().mockReturnValue('/tmp/ch-ext-state/access.json'),
  validateDiscordChannelId: vi.fn().mockReturnValue({ ok: true }),
  findBotTokenDuplicate: vi.fn().mockReturnValue(null),
  parseChannelProvider: vi.fn().mockImplementation((s: string) => ['telegram', 'slack', 'discord', 'googlechat', 'teams'].includes(s) ? s : null),
  VALID_PROVIDERS: new Set(['telegram', 'slack', 'discord', 'googlechat', 'teams']),
}))
vi.mock('../db.js', () => ({
  listPendingChannelRequests: vi.fn().mockReturnValue([]),
  updateChannelRequestStatus: vi.fn().mockReturnValue(true),
}))
vi.mock('../web/plugin-ids.js', () => ({
  CHANNEL_PLUGIN_IDS: { telegram: 'plugin:telegram', slack: 'plugin:slack', discord: 'plugin:discord' },
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

import { tryHandleAgentsChannels } from '../web/routes/agents-channels.js'

function makeCtx(method: string, path: string, body?: object, headers?: Record<string, string>): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = headers ?? {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleAgentsChannels (extended)', () => {
  beforeAll(async () => {
    // Pre-create the .claude dir and a settings.json so setAgentEnabledPlugins (line 121)
    // and resetAgentEnabledPlugins (lines 134-137) hit the file-exists branches.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path')
    const claudeDir = path.join(TEST_AGENT_DIR, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
  })

  it('POST channel test returns 200 when token validates OK', async () => {
    const cp = await import('../channel-provider.js')
    const mockValidate = vi.fn().mockResolvedValueOnce({ ok: true, botName: 'TestBot' })
    vi.mocked(cp.readChannelToken).mockReturnValueOnce('bot123:valid')
    vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram/test')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.botName).toBe('TestBot')
  })

  it('POST channel test returns 400 when token validation fails', async () => {
    const cp = await import('../channel-provider.js')
    const mockValidate = vi.fn().mockResolvedValueOnce({ ok: false, error: 'bad token' })
    vi.mocked(cp.readChannelToken).mockReturnValueOnce('bot123:bad')
    vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram/test')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('bad token')
  })

  it('POST channel setup (telegram) for sub-agent writes config and returns ok', async () => {
    const cp = await import('../channel-provider.js')
    const mockValidate = vi.fn().mockResolvedValueOnce({ ok: true, botName: 'BotName' })
    vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram', { botToken: 'bot123:abc' })
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.botName).toBe('BotName')
    expect(out.body.wasRunning).toBe(false)
  })

  it('POST channel setup (slack) returns 409 when managed-settings not ready', async () => {
    const cp = await import('../channel-provider.js')
    const mockValidate = vi.fn().mockResolvedValueOnce({ ok: true, botName: 'SlackBot' })
    vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/slack', { botToken: 'xoxb-test' })
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    // On macOS the managed settings path doesn't exist in test env -> 409
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('managed-settings-missing')
  })

  it('POST channel setup returns 400 when botToken missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram', { botToken: '' })
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/botToken/)
  })

  it('POST channel setup returns 400 when validateToken fails', async () => {
    const cp = await import('../channel-provider.js')
    const mockValidate = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Unauthorized' })
    vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram', { botToken: 'bot123:bad' })
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('Unauthorized')
  })

  it('DELETE channel teardown for sub-agent returns ok', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/agents/test-agent/channels/telegram')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
  })

  it('GET channel pending returns list for known agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent/channels/telegram/pending')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('POST channel pending approve returns 404 for unknown code', async () => {
    const agentConfig = await import('../web/agent-config.js')
    vi.mocked(agentConfig.readFileOr).mockReturnValueOnce('{}')
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram/approve', { code: 'no-such-code' })
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toMatch(/invalid|expired/i)
  })

  it('POST channel invite create returns token for known agent', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram/invites')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.token).toBeDefined()
  })

  it('GET channel invites list returns array for known agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent/channels/telegram/invites')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('POST reconnect returns 400 when agent not running', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel/reconnect')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/not running/i)
  })
})
