import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// Mock all heavy/side-effectful dependencies so the route handler can be
// imported in a test environment without touching the real DB, filesystem,
// or spawning claude processes.

vi.mock('../web/routes/agents-helpers.js', () => ({
  listAgentSummaries: vi.fn().mockReturnValue([]),
  remotePaneCache: { getOrRefresh: vi.fn().mockReturnValue(null) },
  agentRunStateCached: vi.fn().mockReturnValue('stopped'),
  getAgentDetail: vi.fn().mockReturnValue(null),
  remoteRunStateCache: { getOrRefresh: vi.fn().mockReturnValue('stopped') },
  VALID_PROVIDERS: new Set(['telegram', 'slack', 'discord']),
  parseChannelProvider: vi.fn().mockReturnValue(null),
  validateDiscordChannelId: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn(),
  getDb: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  }),
}))
vi.mock('../web/telegram.js', () => ({
  sendAvatarChangeMessage: vi.fn().mockResolvedValue(undefined),
  readAgentTelegramConfig: vi.fn().mockReturnValue(null),
  readAgentDiscordConfig: vi.fn().mockReturnValue(null),
  readAgentGooglechatConfig: vi.fn().mockReturnValue(null),
  readAgentTeamsConfig: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/agent-scaffold.js', () => ({
  scaffoldAgentDir: vi.fn(),
  generateClaudeMd: vi.fn().mockResolvedValue('# Agent'),
  generateSoulMd: vi.fn().mockResolvedValue('# Soul'),
  writeAgentSettingsFromProfile: vi.fn(),
}))
vi.mock('../web/agent-bundle.js', () => ({
  exportAgentBundle: vi.fn(),
  importAgentBundle: vi.fn(),
  exportAllAgentsBundle: vi.fn(),
  importAllAgentsBundle: vi.fn(),
  peekBundleKind: vi.fn().mockReturnValue('single'),
  bundleFilename: vi.fn().mockReturnValue('bundle.tar.gz'),
  fleetBundleFilename: vi.fn().mockReturnValue('fleet.tar.gz'),
}))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: vi.fn().mockReturnValue(false),
  agentSessionName: vi.fn().mockImplementation((n: string) => `agent-${n}`),
  capturePane: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/model-suggest.js', () => ({
  suggestForAgent: vi.fn().mockReturnValue({ model: 'claude-haiku-4-5', reason: 'low-traffic' }),
}))
vi.mock('../web/token-usage.js', () => ({
  getTokenSummary: vi.fn().mockReturnValue([]),
}))
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: vi.fn().mockReturnValue([]),
}))
vi.mock('../web/federation/onboarding.js', () => ({
  ensureFederationClaudeMdSection: vi.fn(),
}))
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: vi.fn().mockReturnValue([]),
  resolveAgentConfigDir: vi.fn().mockReturnValue('/tmp/config'),
}))
vi.mock('../web/multipart.js', () => ({
  parseMultipart: vi.fn().mockReturnValue({ file: null }),
}))
vi.mock('../web/vault.js', () => ({
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/active-model.js', () => ({
  readActiveModelFromProjectDir: vi.fn().mockReturnValue(null),
  readContextTokensFromProjectDir: vi.fn().mockReturnValue(null),
  projectsDirFor: vi.fn().mockReturnValue('/tmp/projects'),
}))
vi.mock('../pane-state.js', () => ({
  detectPaneState: vi.fn().mockReturnValue('idle'),
}))
vi.mock('../web/profiles.js', () => ({
  loadProfileTemplate: vi.fn().mockReturnValue({}),
  resolveProfilePlaceholders: vi.fn().mockReturnValue({}),
}))
vi.mock('../web/sanitize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/sanitize.js')>()
  return {
    ...actual,
    sanitizeAgentName: vi.fn().mockImplementation((s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')),
  }
})

import { tryHandleAgentsCrud } from '../web/routes/agents-crud.js'

const WEB_DIR = '/tmp/web-test'

function makeCtx(opts: {
  method: string
  path: string
  body?: string
}): { ctx: RouteContext; statusCode: () => number; responseBody: () => unknown } {
  const { method, path, body = '' } = opts

  const em = new EventEmitter()
  Object.assign(em, { headers: {}, method, url: path })
  setImmediate(() => {
    if (body) em.emit('data', Buffer.from(body))
    em.emit('end')
  })

  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }

  const ctx: RouteContext = {
    req: em as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://localhost${path}`),
    auth: { kind: 'token' },
  }
  return {
    ctx,
    statusCode: () => code,
    responseBody: () => {
      try { return JSON.parse(resBody) } catch { return resBody }
    },
  }
}

describe('agents-crud routes', () => {
  it('GET /api/agents returns 200 with an array', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents' })
    const handled = await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(handled).toBe(true)
    expect(statusCode()).toBe(200)
    expect(Array.isArray(responseBody())).toBe(true)
  })

  it('POST /api/agents with missing name returns 400', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'POST',
      path: '/api/agents',
      body: JSON.stringify({ description: 'A test agent' }),
    })
    const handled = await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(handled).toBe(true)
    expect(statusCode()).toBe(400)
    expect(responseBody()).toMatchObject({ error: expect.stringContaining('required') })
  })

  it('POST /api/agents with missing description returns 400', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'POST',
      path: '/api/agents',
      body: JSON.stringify({ name: 'testbot' }),
    })
    const handled = await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(handled).toBe(true)
    expect(statusCode()).toBe(400)
    expect(responseBody()).toMatchObject({ error: expect.stringContaining('required') })
  })

  it('DELETE /api/agents/nonexistent returns 404', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'DELETE',
      path: '/api/agents/definitely-nonexistent-agent-xyz',
    })
    const handled = await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(handled).toBe(true)
    expect(statusCode()).toBe(404)
    expect(responseBody()).toMatchObject({ error: 'not_found' })
  })

  it('unrelated path returns false', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/unrelated' })
    const handled = await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(handled).toBe(false)
  })
})
