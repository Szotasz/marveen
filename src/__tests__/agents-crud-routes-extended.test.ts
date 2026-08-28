// Extended agents-crud route tests: cover the 404 paths for routes that check
// agent existence, plus routes that don't require a real agent dir (activity,
// model-suggest, team/graph). The base agents-crud-routes.test.ts already covers
// GET /api/agents, POST /api/agents 400, DELETE 404, and unmatched route.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const { TEST_AGENT_DIR, DEL_AGENT_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  const root = mkdtempSync(join(tmpdir(), 'agents-crud-ext-'))
  const dir = join(root, 'test-agent')
  mkdirSync(dir, { recursive: true })
  const delDir = join(root, 'del-agent')
  mkdirSync(delDir, { recursive: true })
  return { TEST_AGENT_DIR: dir, DEL_AGENT_DIR: delDir }
})

vi.mock('../web/routes/agents-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/routes/agents-helpers.js')>()
  return {
    ...actual,
    listAgentSummaries: vi.fn().mockReturnValue([]),
    remotePaneCache: { getOrRefresh: vi.fn().mockReturnValue(null) },
    agentRunStateCached: vi.fn().mockReturnValue('stopped'),
    getAgentDetail: vi.fn().mockReturnValue({ name: 'test-agent', model: 'claude-haiku-4-5' }),
    remoteRunStateCache: { getOrRefresh: vi.fn().mockReturnValue('stopped') },
    VALID_PROVIDERS: new Set(['telegram', 'slack', 'discord']),
    parseChannelProvider: vi.fn().mockReturnValue(null),
    validateDiscordChannelId: vi.fn().mockReturnValue({ ok: true }),
  }
})
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
  scaffoldAgentMemoriaHeartbeat: vi.fn(),
  generateClaudeMd: vi.fn().mockResolvedValue('# Agent'),
  generateSoulMd: vi.fn().mockResolvedValue('# Soul'),
  writeAgentSettingsFromProfile: vi.fn(),
}))
vi.mock('../web/agent-bundle.js', () => ({
  exportAgentBundle: vi.fn().mockResolvedValue(undefined),
  importAgentBundle: vi.fn(),
  exportAllAgentsBundle: vi.fn().mockResolvedValue(undefined),
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
  readClaudePlans: vi.fn().mockReturnValue([{ id: 'plan-a', name: 'Plan A' }]),
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
  detectPermissionMode: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/profiles.js', () => ({
  loadProfileTemplate: vi.fn().mockReturnValue({ id: 'default', label: 'Default', description: '', permissionMode: 'default', filesystem: { allow: [], deny: [] } }),
  resolveProfilePlaceholders: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../web/sanitize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/sanitize.js')>()
  return {
    ...actual,
    sanitizeAgentName: vi.fn().mockImplementation((s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')),
  }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    isKnownAgent: vi.fn().mockImplementation((name: string) => name === 'test-agent'),
    readAgentDisplayName: vi.fn().mockReturnValue('Test Agent'),
    readAgentSecurityProfile: vi.fn().mockReturnValue('default'),
    readAgentVoiceConfig: vi.fn().mockReturnValue({ mode: 'text', voiceModel: null, voiceId: null }),
    writeAgentVoiceConfig: vi.fn(),
    writeAgentModel: vi.fn(),
    writeAgentAuthMode: vi.fn(),
    writeAgentClaudePlan: vi.fn(),
    writeAgentMemoryIsolation: vi.fn(),
    writeAgentDisplayName: vi.fn(),
    writeAgentSecurityProfile: vi.fn(),
    readAgentModel: vi.fn().mockReturnValue('claude-haiku-4-5'),
    listAgentNames: vi.fn().mockReturnValue([]),
    agentDir: vi.fn().mockImplementation((name: string) => {
      if (name === 'test-agent') return TEST_AGENT_DIR
      if (name === 'del-agent') return DEL_AGENT_DIR
      return `/tmp/agents/${name}`
    }),
    agentConfigRoot: vi.fn().mockImplementation((name: string) => name === 'test-agent' ? TEST_AGENT_DIR : `/tmp/agents/${name}`),
    readFileOr: vi.fn().mockReturnValue(''),
    findAvatarForAgent: vi.fn().mockReturnValue(null),
    readAgentRemoteHost: vi.fn().mockReturnValue(null),
    resolveModelId: vi.fn().mockImplementation((s: string) => s),
    DEFAULT_MODEL: 'claude-opus-4-8[1m]',
    readAgentTeam: vi.fn().mockReturnValue({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [], trustSources: [] }),
  }
})
vi.mock('../web/agent-team.js', () => ({
  readAgentTeam: vi.fn().mockReturnValue({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [], trustSources: [] }),
  writeAgentTeam: vi.fn(),
  sanitizeTeamConfig: vi.fn().mockImplementation((cfg: any) => cfg),
  cleanupTeamReferences: vi.fn(),
  reportsToCreatesCycle: vi.fn().mockReturnValue(false),
}))
vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: vi.fn().mockReturnValue(false),
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

import { tryHandleAgentsCrud } from '../web/routes/agents-crud.js'

function makeCtx(opts: { method: string; path: string; body?: string }): {
  ctx: RouteContext; statusCode: () => number; responseBody: () => unknown
} {
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
  return { ctx, statusCode: () => code, responseBody: () => { try { return JSON.parse(resBody) } catch { return resBody } } }
}

const WEB_DIR = '/tmp/web-test'

describe('agents-crud routes (extended)', () => {
  it('GET /api/agents/activity returns 200 with empty entries', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/activity' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(Array.isArray(body)).toBe(true)
  })

  it('POST /api/agents/model-suggest returns 200 with results', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'POST', path: '/api/agents/model-suggest', body: '{}' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(Array.isArray(body.results)).toBe(true)
  })

  it('GET /api/team/graph returns 200 with nodes and edges', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/team/graph' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(Array.isArray(body.nodes)).toBe(true)
    expect(Array.isArray(body.edges)).toBe(true)
  })

  it('GET /api/agents/:name returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/ghost-xyz' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('GET /api/agents/:name returns 200 for known agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/test-agent' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
  })

  it('PUT /api/agents/:name returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'PUT', path: '/api/agents/ghost-xyz', body: '{}' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('PUT /api/agents/:name updates model and returns ok', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent',
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('PUT /api/agents/:name returns 400 for unknown claudePlan id', async () => {
    const { ctx, statusCode } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent',
      body: JSON.stringify({ claudePlan: 'nonexistent-plan' }),
    })
    await tryHandleAgentsCrud(ctx, WEB_DIR)
    expect(statusCode()).toBe(400)
  })

  it('GET /api/agents/:name/security returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/ghost-xyz/security' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('PUT /api/agents/:name/security returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'PUT', path: '/api/agents/ghost-xyz/security', body: '{"profile":"default"}' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('GET /api/agents/:name/team returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/ghost-xyz/team' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('PUT /api/agents/:name/team returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'PUT', path: '/api/agents/ghost-xyz/team', body: '{}' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('GET /api/agents/:name/export returns 404 for unknown agent dir', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/ghost-xyz/export' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('GET /api/agents/:name/voice-config returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/ghost-xyz/voice-config' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('GET /api/agents/:name/voice-config returns config for known agent', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/test-agent/voice-config' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).mode).toBe('text')
  })

  it('PUT /api/agents/:name/voice-config returns 404 for unknown agent', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'PUT', path: '/api/agents/ghost-xyz/voice-config', body: '{"mode":"voice"}' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(404)
  })

  it('PUT /api/agents/:name/voice-config updates config for known agent', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'PUT', path: '/api/agents/test-agent/voice-config', body: '{"mode":"voice"}' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('GET /api/agents/export-all triggers export and returns archive', async () => {
    const bundle = await import('../web/agent-bundle.js')
    vi.mocked(bundle.exportAllAgentsBundle).mockImplementationOnce((outPath, _names) => {
      // Write a tiny file so the serveFile call works
      const { writeFileSync } = require('node:fs')
      writeFileSync(outPath, Buffer.from('PK'))
      return { schemaVersion: 1, kind: 'fleet', agents: [], includesSecrets: false }
    })
    const ctx = makeCtx({ method: 'GET', path: '/api/agents/export-all' })
    expect(await tryHandleAgentsCrud(ctx.ctx, WEB_DIR)).toBe(true)
  })

  it('POST /api/agents/import with no file returns 400', async () => {
    const { ctx, statusCode } = makeCtx({ method: 'POST', path: '/api/agents/import', body: '' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(400)
  })

  it('PUT /api/agents/:name/team updates team for known agent', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent/team',
      body: JSON.stringify({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('POST /api/agents creates new agent successfully', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'POST', path: '/api/agents',
      body: JSON.stringify({ name: 'new-agent', description: 'A brand new agent' }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
    expect((responseBody() as any).name).toBeTruthy()
  })

  it('POST /api/agents returns 409 when agent already exists', async () => {
    const { ctx, statusCode } = makeCtx({
      method: 'POST', path: '/api/agents',
      body: JSON.stringify({ name: 'test-agent', description: 'Duplicate agent' }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(409)
  })

  it('DELETE /api/agents/del-agent removes existing agent', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'DELETE', path: '/api/agents/del-agent' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('GET /api/agents/test-agent/security returns security profile', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/test-agent/security' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(body.profile).toBe('default')
  })

  it('PUT /api/agents/test-agent/security updates profile successfully', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent/security',
      body: JSON.stringify({ profile: 'default' }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('PUT /api/agents/test-agent/security returns 400 for missing profile', async () => {
    const { ctx, statusCode } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent/security',
      body: JSON.stringify({}),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(400)
  })

  it('PUT /api/agents/test-agent updates authMode to api', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent',
      body: JSON.stringify({ authMode: 'api', apiKey: 'sk-test-key' }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('PUT /api/agents/test-agent clears authMode from api', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent',
      body: JSON.stringify({ authMode: 'claude-credentials' }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('PUT /api/agents/test-agent clears claudePlan with empty string', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'PUT', path: '/api/agents/test-agent',
      body: JSON.stringify({ claudePlan: '' }),
    })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('GET /api/agents/test-agent/team returns team config for known agent', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/test-agent/team' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(body.role).toBe('member')
  })

  it('GET /api/agents/activity returns running state for main agent', async () => {
    const { capturePane } = await import('../web/agent-process.js')
    vi.mocked(capturePane).mockReturnValueOnce('$ cmd\nsome output line')
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/activity' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].running).toBe(true)
    expect(body[0].state).toBe('idle') // detectPaneState mock returns 'idle'
    expect(body[0].tail.length).toBeGreaterThan(0)
  })

  it('GET /api/agents/activity returns running state for sub-agent', async () => {
    const agentConfig = await import('../web/agent-config.js')
    const helpers = await import('../web/routes/agents-helpers.js')
    const { capturePane } = await import('../web/agent-process.js')
    vi.mocked(agentConfig.listAgentNames).mockReturnValueOnce(['test-agent'])
    vi.mocked(helpers.agentRunStateCached).mockReturnValueOnce('running')
    vi.mocked(capturePane)
      .mockReturnValueOnce(null)                    // main agent: not running
      .mockReturnValueOnce('$ task\nresult here')   // sub-agent pane
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/activity' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    const subEntry = body.find((e: any) => e.name === 'test-agent')
    expect(subEntry).toBeDefined()
    expect(subEntry.running).toBe(true)
    expect(subEntry.tail.length).toBeGreaterThan(0)
  })

  it('POST /api/agents/:name/avatar uses gallery avatar from webDir', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: pjoin } = require('node:path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tmpdir } = require('node:os')
    const testWd = mkdtempSync(pjoin(tmpdir(), 'web-avatar-'))
    mkdirSync(pjoin(testWd, 'avatars'), { recursive: true })
    writeFileSync(pjoin(testWd, 'avatars', 'gal.png'), Buffer.from('PNG'))
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'POST', path: '/api/agents/test-agent/avatar',
      body: JSON.stringify({ galleryAvatar: 'gal.png' }),
    })
    ;(ctx.req as any).headers['content-type'] = 'application/json'
    expect(await tryHandleAgentsCrud(ctx, testWd)).toBe(true)
    expect(statusCode()).toBe(200)
    expect((responseBody() as any).ok).toBe(true)
  })

  it('GET /api/agents/:name/avatar serves existing avatar file', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writeFileSync } = require('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: pjoin } = require('node:path')
    const avatarPath = pjoin(TEST_AGENT_DIR, 'avatar-serve.png')
    writeFileSync(avatarPath, Buffer.from('\x89PNG'))
    const agentConfig = await import('../web/agent-config.js')
    vi.mocked(agentConfig.findAvatarForAgent).mockReturnValueOnce(avatarPath)
    const { ctx, statusCode } = makeCtx({ method: 'GET', path: '/api/agents/test-agent/avatar' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
  })

  it('GET /api/agents/activity shows unreachable state for sub-agent', async () => {
    const agentConfig = await import('../web/agent-config.js')
    const helpers = await import('../web/routes/agents-helpers.js')
    vi.mocked(agentConfig.listAgentNames).mockReturnValueOnce(['test-agent'])
    vi.mocked(helpers.agentRunStateCached).mockReturnValueOnce('unreachable')
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/activity' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    const sub = body.find((e: any) => e.name === 'test-agent')
    expect(sub).toBeDefined()
    expect(sub.state).toBe('unreachable')
    expect(sub.running).toBe(false)
  })

  it('POST /api/agents/model-suggest with real kanban and token data', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writeFileSync, mkdirSync } = require('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join: pjoin } = require('node:path')
    // Write a fake .mcp.json so mcpServerCount returns > 0
    writeFileSync(pjoin(TEST_AGENT_DIR, '.mcp.json'), JSON.stringify({ mcpServers: { 'test-server': {} } }))

    const agentConfig = await import('../web/agent-config.js')
    const tokenUsage = await import('../web/token-usage.js')
    const schedIO = await import('../web/scheduled-tasks-io.js')
    const db = await import('../db.js')

    vi.mocked(agentConfig.listAgentNames).mockReturnValueOnce(['test-agent'])
    vi.mocked(tokenUsage.getTokenSummary).mockReturnValueOnce([
      { agent: 'test-agent', totalCalls: 10, totalInput: 50000, totalOutput: 5000, totalCacheRead: 0, totalCacheWrite: 0 },
    ] as any)
    vi.mocked(db.getDb).mockReturnValueOnce({
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          { assignee: 'test-agent', priority: 'urgent', cnt: 2 },
          { assignee: 'test-agent', priority: 'low', cnt: 1 },
        ]),
      }),
    } as any)
    vi.mocked(schedIO.listScheduledTasks).mockReturnValueOnce([
      { name: 'task-a', schedule: '*/30 * * * *', agent: 'test-agent', enabled: true, description: '', prompt: '', createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false },
      { name: 'task-b', schedule: '0 * * * *', agent: 'test-agent', enabled: true, description: '', prompt: '', createdAt: 0, type: 'heartbeat', skipIfBusy: false, forceSend: false },
      { name: 'task-c', schedule: '0 */6 * * *', agent: 'test-agent', enabled: true, description: '', prompt: '', createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false },
      { name: 'task-d', schedule: 'short', agent: 'test-agent', enabled: false, description: '', prompt: '', createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false },
    ] as any)

    const { ctx, statusCode, responseBody } = makeCtx({ method: 'POST', path: '/api/agents/model-suggest', body: '{}' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(Array.isArray(body.results)).toBe(true)
  })

  it('GET /api/agents/activity shows unknown when sub-agent is running but pane is null', async () => {
    const agentConfig = await import('../web/agent-config.js')
    const helpers = await import('../web/routes/agents-helpers.js')
    const { capturePane } = await import('../web/agent-process.js')
    vi.mocked(agentConfig.listAgentNames).mockReturnValueOnce(['test-agent'])
    vi.mocked(helpers.agentRunStateCached).mockReturnValueOnce('running')
    vi.mocked(capturePane)
      .mockReturnValueOnce(null) // main agent not running
      .mockReturnValueOnce(null) // sub-agent running but pane null
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/activity' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    const sub = body.find((e: any) => e.name === 'test-agent')
    expect(sub).toBeDefined()
    expect(sub.running).toBe(true)
    expect(sub.state).toBe('unknown')
  })

  it('GET /api/agents/activity shows working when detectPaneState returns busy', async () => {
    const { capturePane } = await import('../web/agent-process.js')
    const { detectPaneState } = await import('../pane-state.js')
    vi.mocked(capturePane).mockReturnValueOnce('$ long running task...')
    vi.mocked(detectPaneState).mockReturnValueOnce('busy')
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/activity' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(body[0].state).toBe('working')
  })

  it('GET /api/agents/activity returns raw state for non-standard pane state', async () => {
    const { capturePane } = await import('../web/agent-process.js')
    const { detectPaneState } = await import('../pane-state.js')
    vi.mocked(capturePane).mockReturnValueOnce('error output')
    vi.mocked(detectPaneState).mockReturnValueOnce('error')
    const { ctx, statusCode, responseBody } = makeCtx({ method: 'GET', path: '/api/agents/activity' })
    expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
    expect(statusCode()).toBe(200)
    const body = responseBody() as any
    expect(body[0].state).toBe('error')
  })

  // Regression guard: PUT /api/agents/:name error codes must be stable machine
  // tokens. Before this fix the route passed fieldCheck.message (a prose sentence)
  // as the `error` field. Strict equality so reverting the fix fails immediately.
  describe('PUT /api/agents/:name: error codes are snake_case machine tokens', () => {
    it('unknown field → invalid_value (not a prose sentence)', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/test-agent',
        body: JSON.stringify({ securityProfile: 'researcher' }),
      })
      expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
      expect(statusCode()).toBe(400)
      const body = responseBody() as any
      expect(body.error).toBe('invalid_value')
      expect(typeof body.field).toBe('string')
      expect(typeof body.hint).toBe('string')
      // The prose sentence must not appear as the error value.
      expect(body.error).not.toContain('Unsupported field')
    })

    it('non-object body → parse_error (not a prose sentence)', async () => {
      const { ctx, statusCode, responseBody } = makeCtx({
        method: 'PUT',
        path: '/api/agents/test-agent',
        body: '"just-a-string"',
      })
      expect(await tryHandleAgentsCrud(ctx, WEB_DIR)).toBe(true)
      expect(statusCode()).toBe(400)
      const body = responseBody() as any
      expect(body.error).toBe('parse_error')
      expect(body.error).not.toContain('Request body')
    })
  })
})
