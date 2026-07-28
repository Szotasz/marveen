/**
 * Route-level tests for mcpScope REST surface:
 *   GET /api/agents/:name  -> response includes mcpScope field
 *   PUT /api/agents/:name  -> mcpScope persisted; model/displayName preserved
 *
 * Synthetic agent names only ("test-agent", "scoped-agent") -- no real fleet
 * agent names hardcoded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const { writeAgentMcpScopeSpy, writeAgentModelSpy } = vi.hoisted(() => ({
  writeAgentMcpScopeSpy: vi.fn(),
  writeAgentModelSpy: vi.fn(),
}))

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockReturnValue('/tmp/fake-agent'),
    agentConfigRoot: vi.fn().mockReturnValue('/tmp/fake-agent'),
    isKnownAgent: vi.fn().mockReturnValue(true),
    readAgentModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    writeAgentModel: writeAgentModelSpy,
    readAgentDisplayName: vi.fn().mockReturnValue('Test Agent'),
    writeAgentDisplayName: vi.fn(),
    readAgentMemoryIsolation: vi.fn().mockReturnValue(false),
    writeAgentMemoryIsolation: vi.fn(),
    readAgentAuthMode: vi.fn().mockReturnValue('default'),
    writeAgentAuthMode: vi.fn(),
    readAgentClaudePlan: vi.fn().mockReturnValue(null),
    writeAgentClaudePlan: vi.fn(),
    readAgentMcpScopeRaw: vi.fn().mockReturnValue({ github: ['list_issues'] }),
    writeAgentMcpScope: writeAgentMcpScopeSpy,
    readAgentVoiceConfig: vi.fn().mockReturnValue(null),
    writeAgentVoiceConfig: vi.fn(),
    readAgentRemoteHost: vi.fn().mockReturnValue(null),
    readAgentSecurityProfile: vi.fn().mockReturnValue('default'),
    writeAgentSecurityProfile: vi.fn(),
    findAvatarForAgent: vi.fn().mockReturnValue(null),
    readFileOr: vi.fn().mockReturnValue(''),
    listAgentNames: vi.fn().mockReturnValue(['test-agent']),
    KNOWN_VOICE_MODELS: [],
  }
})

vi.mock('../web/routes/agents-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/routes/agents-helpers.js')>()
  return {
    ...actual,
    getAgentDetail: vi.fn().mockReturnValue({
      name: 'test-agent',
      model: 'claude-sonnet-4-6',
      mcpScope: { github: ['list_issues', 'get_issue'] },
      mcpJson: '{}',
      claudeMd: '',
      soulMd: '',
      skills: [],
      hasAvatar: false,
      hasApiKey: false,
      memoryIsolation: false,
    }),
    listAgentSummaries: vi.fn().mockReturnValue([]),
    remotePaneCache: { getOrRefresh: vi.fn().mockReturnValue(null) },
    agentRunStateCached: vi.fn().mockReturnValue('stopped'),
    remoteRunStateCache: { getOrRefresh: vi.fn().mockReturnValue('stopped') },
    VALID_PROVIDERS: new Set(['telegram', 'slack', 'discord']),
    parseChannelProvider: vi.fn().mockReturnValue(null),
    validateDiscordChannelId: vi.fn().mockReturnValue({ ok: true }),
    assertAgentExists: vi.fn().mockReturnValue(true),
  }
})

vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn(),
  getDb: vi.fn().mockReturnValue({ prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }) }),
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
  generateClaudeMd: vi.fn().mockResolvedValue(''),
  generateSoulMd: vi.fn().mockResolvedValue(''),
  writeAgentSettingsFromProfile: vi.fn(),
}))
vi.mock('../web/agent-bundle.js', () => ({
  exportAgentBundle: vi.fn(), importAgentBundle: vi.fn(),
  exportAllAgentsBundle: vi.fn().mockReturnValue({ schemaVersion: 1, kind: 'fleet', agents: [], includesSecrets: false }),
  importAllAgentsBundle: vi.fn(), peekBundleKind: vi.fn().mockReturnValue('single'),
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
vi.mock('../web/token-usage.js', () => ({ getTokenSummary: vi.fn().mockReturnValue([]) }))
vi.mock('../web/scheduled-tasks-io.js', () => ({ listScheduledTasks: vi.fn().mockReturnValue([]) }))
vi.mock('../web/federation/onboarding.js', () => ({ ensureFederationClaudeMdSection: vi.fn() }))
vi.mock('../web/claude-plans.js', () => ({
  readClaudePlans: vi.fn().mockReturnValue([]),
  resolveAgentConfigDir: vi.fn().mockReturnValue('/tmp/config'),
}))
vi.mock('../web/multipart.js', () => ({ parseMultipart: vi.fn().mockReturnValue({ file: null }) }))
vi.mock('../web/vault.js', () => ({
  setSecret: vi.fn(), deleteSecret: vi.fn(), getSecret: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/active-model.js', () => ({
  readActiveModelFromProjectDir: vi.fn().mockReturnValue(null),
  readContextTokensFromProjectDir: vi.fn().mockReturnValue(null),
  projectsDirFor: vi.fn().mockReturnValue('/tmp/projects'),
}))
vi.mock('../pane-state.js', () => ({ detectPaneState: vi.fn().mockReturnValue('idle') }))
vi.mock('../web/profiles.js', () => ({
  loadProfileTemplate: vi.fn().mockReturnValue({ filesystem: { allow: [], deny: [] } }),
  resolveProfilePlaceholders: vi.fn().mockReturnValue(''),
}))
vi.mock('../web/sanitize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/sanitize.js')>()
  return {
    ...actual,
    sanitizeAgentName: vi.fn().mockImplementation((s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')),
  }
})

import { tryHandleAgentsCrud } from '../web/routes/agents-crud.js'

function makeCtx(method: string, path: string, body?: unknown): {
  ctx: RouteContext
  out: { status: number; body: unknown }
} {
  const em = new EventEmitter()
  Object.assign(em, { headers: { 'content-type': 'application/json' }, method, url: path })
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  setImmediate(() => {
    if (bodyStr) em.emit('data', Buffer.from(bodyStr))
    em.emit('end')
  })
  const out = { status: 200, body: {} as unknown }
  const res = {
    writeHead: (c: number) => { out.status = c },
    end: (d?: string) => { try { out.body = JSON.parse(d ?? '{}') } catch { out.body = d } },
  }
  const ctx: RouteContext = {
    req: em as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://localhost${path}`),
    auth: { kind: 'token' },
  }
  return { ctx, out }
}

const WEB_DIR = '/tmp/web-test'

beforeEach(() => {
  writeAgentMcpScopeSpy.mockClear()
  writeAgentModelSpy.mockClear()
})

describe('GET /api/agents/:name -- mcpScope in response', () => {
  it('returns mcpScope field in agent detail', async () => {
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent')
    await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(out.status).toBe(200)
    const body = out.body as Record<string, unknown>
    expect(body).toHaveProperty('mcpScope')
    expect(body.mcpScope).toEqual({ github: ['list_issues', 'get_issue'] })
  })

  it('mcpScope is null for unmanaged agent (getAgentDetail returns null scope)', async () => {
    const { getAgentDetail } = await import('../web/routes/agents-helpers.js')
    vi.mocked(getAgentDetail).mockReturnValueOnce({
      name: 'unmanaged-agent', model: 'claude-sonnet-4-6',
      mcpScope: null,
      mcpJson: '{}', claudeMd: '', soulMd: '', skills: [],
      hasAvatar: false, hasApiKey: false, memoryIsolation: false,
    } as any)
    const { ctx, out } = makeCtx('GET', '/api/agents/test-agent')
    await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect((out.body as any).mcpScope).toBeNull()
  })
})

describe('PUT /api/agents/:name -- mcpScope persistence', () => {
  it('calls writeAgentMcpScope when mcpScope is provided', async () => {
    const scope = { github: ['list_issues', 'search_code'], gitlab: '*' as const }
    const { ctx, out } = makeCtx('PUT', '/api/agents/test-agent', { mcpScope: scope })
    await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(out.status).toBe(200)
    expect(writeAgentMcpScopeSpy).toHaveBeenCalledOnce()
    expect(writeAgentMcpScopeSpy).toHaveBeenCalledWith('test-agent', scope)
  })

  it('does not call writeAgentMcpScope when mcpScope absent from body', async () => {
    const { ctx } = makeCtx('PUT', '/api/agents/test-agent', { model: 'claude-haiku-4-5' })
    await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(writeAgentMcpScopeSpy).not.toHaveBeenCalled()
  })

  it('preserves model field when only mcpScope is sent', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/agents/test-agent', {
      mcpScope: { github: ['list_issues'] },
    })
    await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(out.status).toBe(200)
    // model was not in body -> writeAgentModel not called
    expect(writeAgentModelSpy).not.toHaveBeenCalled()
    expect(writeAgentMcpScopeSpy).toHaveBeenCalledOnce()
  })

  it('handles both mcpScope and model in the same PUT', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/agents/test-agent', {
      model: 'claude-haiku-4-5',
      mcpScope: { gitlab: ['list_merge_requests'] },
    })
    await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(out.status).toBe(200)
    expect(writeAgentModelSpy).toHaveBeenCalledWith('test-agent', 'claude-haiku-4-5')
    expect(writeAgentMcpScopeSpy).toHaveBeenCalledWith('test-agent', { gitlab: ['list_merge_requests'] })
  })
})
