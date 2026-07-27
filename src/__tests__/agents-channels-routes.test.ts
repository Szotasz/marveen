import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { TEST_AGENT_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir, join } = [require('node:os'), require('node:path')].reduce((a, b) => ({ ...a, ...b })) as any
  const root = mkdtempSync(join(tmpdir(), 'channels-test-'))
  const dir = join(root, 'test-agent')
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
    channelStateDir: vi.fn().mockReturnValue('/tmp/channel-state'),
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
  readAgentTelegramConfig: vi.fn().mockReturnValue(null),
  readMarveenTelegramConfig: vi.fn().mockReturnValue(null),
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
vi.mock('../web/routes/agents-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/routes/agents-helpers.js')>()
  return {
    ...actual,
    matchChannelRoute: vi.fn().mockImplementation((path: string, suffix: string) => {
      const pattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`)
      const match = path.match(pattern)
      if (match) return [decodeURIComponent(match[1]), match[2]]
      return null
    }),
    resolveAccessPath: vi.fn().mockReturnValue('/tmp/channel-state/access.json'),
    validateDiscordChannelId: vi.fn().mockReturnValue({ ok: true }),
    findBotTokenDuplicate: vi.fn().mockReturnValue(null),
    parseChannelProvider: vi.fn().mockImplementation((s: string) => ['telegram', 'slack', 'discord', 'googlechat', 'teams'].includes(s) ? s : null),
    VALID_PROVIDERS: new Set(['telegram', 'slack', 'discord', 'googlechat', 'teams']),
  }
})
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

function makeCtx(method: string, path: string, body?: object): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleAgentsChannels', () => {
  it('GET slack manifest returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/ghost-xyz/channels/slack/manifest')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET slack manifest returns manifest for known agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent/channels/slack/manifest')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.manifest).toBeDefined()
  })

  it('POST slack smoke-test returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/ghost-xyz/channels/slack/smoke-test')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST slack smoke-test returns 400 when not slack provider', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/slack/smoke-test')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('POST reconnect returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/ghost-xyz/channel/reconnect')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST reconnect for marveen (MAIN_AGENT_ID) bypasses dir check', async () => {
    const reconnect = await import('../web/channel-mcp-reconnect.js')
    vi.mocked(reconnect.attemptChannelMcpReconnect).mockReturnValueOnce({ ok: true, message: 'reconnected' })
    const { ctx, out } = makeCtx('POST', '/api/agents/marveen/channel/reconnect')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.body.ok).toBe(true)
  })

  it('GET channel health returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/ghost-xyz/channel/health')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET channel health returns 200 for marveen (MAIN_AGENT_ID)', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/marveen/channel/health')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('ok')
  })

  it('GET channel health returns 200 for known agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent/channel/health')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET channel requests for unknown agent returns 404', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/ghost-xyz/channel-requests')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET channel requests for known agent returns list', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent/channel-requests')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
  })

  it('POST approve channel request for unknown agent returns 404', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/ghost-xyz/channel-requests/1/approve')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST deny channel request for unknown agent returns 404', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/ghost-xyz/channel-requests/1/deny')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('DELETE invite token for unknown agent returns 404', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/agents/ghost-xyz/channels/telegram/invites/tok-abc')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('DELETE allowed user for unknown agent returns 404', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/agents/ghost-xyz/channels/telegram/allowed/user/123')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST channel setup returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/ghost-xyz/channels/telegram', { token: 'bot123:abc' })
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST channel test returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/ghost-xyz/channels/telegram/test')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST channel test returns 404 when no token configured', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram/test')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET channel allowed list returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/ghost-xyz/channels/telegram/allowed')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET channel allowed list returns 200 for known agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent/channels/telegram/allowed')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('DELETE channel config (teardown) returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/agents/ghost-xyz/channels/telegram')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('GET channel pending returns 404 for unknown agent', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/ghost-xyz/channels/telegram/pending')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('POST approve channel request for known agent returns 200 or 404', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel-requests/999/approve')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    // Returns either 404 (request not found) or 200 (approved)
    expect([200, 404]).toContain(out.status)
  })

  it('POST deny channel request for known agent returns 200 or 404', async () => {
    const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel-requests/999/deny')
    expect(await tryHandleAgentsChannels(ctx)).toBe(true)
    expect([200, 404]).toContain(out.status)
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/other-route')
    expect(await tryHandleAgentsChannels(ctx)).toBe(false)
  })
})
