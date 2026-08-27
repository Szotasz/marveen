import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// Isolate dashboard-settings: addExternalProjectPath returns structured errors
vi.mock('../web/dashboard-settings.js', () => ({
  addExternalProjectPath: vi.fn(),
  removeExternalProjectPath: vi.fn().mockReturnValue([]),
  getExternalProjectPaths: vi.fn().mockReturnValue([]),
  installGitHubRepo: vi.fn(),
  getGitHubRepos: vi.fn().mockReturnValue([]),
  removeGitHubRepo: vi.fn(),
  updateGitHubRepo: vi.fn(),
  detectRequiredEnvVars: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/vault.js', () => ({ getSecret: vi.fn().mockReturnValue(null), setSecret: vi.fn() }))
vi.mock('../web/agent-config.js', () => ({
  readFileOr: vi.fn().mockReturnValue('{}'),
  agentDir: vi.fn(),
  agentConfigRoot: vi.fn(),
  listAgentNames: vi.fn().mockReturnValue([]),
  readAgentCapabilities: vi.fn().mockReturnValue([]),
}))
vi.mock('../web/routes/connectors-mcp.js', () => ({ tryHandleMcpConnectors: vi.fn().mockResolvedValue(false) }))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp',
  STORE_DIR: '/tmp',
  OWNER_NAME: 'test',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

import { addExternalProjectPath, installGitHubRepo, removeGitHubRepo, updateGitHubRepo } from '../web/dashboard-settings.js'
import { tryHandleConnectors } from '../web/routes/connectors.js'

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('connectors token-to-status mapping', () => {
  it('POST /api/connectors/external-paths: not_found -> 404', async () => {
    vi.mocked(addExternalProjectPath).mockReturnValue({ paths: [], error: 'not_found', hint: 'Directory does not exist', field: 'path' })
    const { ctx, out } = makeCtx('POST', '/api/connectors/external-paths', { path: '/no/such/dir' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })

  it('POST /api/connectors/external-paths: required -> 400', async () => {
    vi.mocked(addExternalProjectPath).mockReturnValue({ paths: [], error: 'required', hint: 'Absolute path required', field: 'path' })
    const { ctx, out } = makeCtx('POST', '/api/connectors/external-paths', { path: 'relative' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('required')
  })

  it('POST /api/connectors/github-repos: conflict -> 409', async () => {
    vi.mocked(installGitHubRepo).mockResolvedValue({ error: 'conflict', hint: 'Already installed: owner--repo' })
    const { ctx, out } = makeCtx('POST', '/api/connectors/github-repos', { url: 'https://github.com/owner/repo' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(409)
    expect((out.body as { error: string }).error).toBe('conflict')
  })

  it('POST /api/connectors/github-repos: invalid_value -> 400', async () => {
    vi.mocked(installGitHubRepo).mockResolvedValue({ error: 'invalid_value', field: 'url', hint: 'Invalid GitHub URL' })
    const { ctx, out } = makeCtx('POST', '/api/connectors/github-repos', { url: 'https://github.com/owner/repo' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('invalid_value')
  })

  it('PATCH /api/connectors/github-repos/:name: not_found -> 404', async () => {
    vi.mocked(updateGitHubRepo).mockReturnValue({ ok: false, error: 'not_found', hint: 'Repo not found' })
    const { ctx, out } = makeCtx('PATCH', '/api/connectors/github-repos/owner--repo')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })
})
