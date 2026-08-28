// Error-shape tests for connectors endpoints (#672 B14).
// Covers: catalog install/uninstall 500 branches, vault-binding no-targets 400.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return {
    ...orig,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn((p: string, _enc?: string) => {
      // mcp-catalog.json: return a minimal valid catalog entry
      if (String(p).endsWith('mcp-catalog.json')) {
        return JSON.stringify([
          { id: 'test-connector', type: 'local', command: 'npx', args: ['test-pkg'], env: {} },
        ])
      }
      return orig.readFileSync(p, _enc as BufferEncoding | undefined)
    }),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
  AGENTS_BASE_DIR: '/tmp/mock-agents',
  MAIN_AGENT_ID: 'agent-a',
  OLLAMA_URL: '',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_NAME: 'test',
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: vi.fn().mockReturnValue('{}'),
  agentDir: vi.fn(),
  agentConfigRoot: vi.fn(),
  readAgentCapabilities: vi.fn().mockReturnValue([]),
  AGENTS_BASE_DIR: '/tmp/mock-agents',
}))

vi.mock('../web/dashboard-settings.js', () => ({
  addExternalProjectPath: vi.fn().mockReturnValue({ paths: [], error: 'not_found', hint: 'not found' }),
  removeExternalProjectPath: vi.fn().mockReturnValue([]),
  getExternalProjectPaths: vi.fn().mockReturnValue([]),
  installGitHubRepo: vi.fn(),
  getGitHubRepos: vi.fn().mockReturnValue([]),
  removeGitHubRepo: vi.fn(),
  updateGitHubRepo: vi.fn(),
  detectRequiredEnvVars: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn().mockReturnValue(null),
  setSecret: vi.fn(),
  listSecrets: vi.fn().mockReturnValue([]),
  deleteSecret: vi.fn(),
}))

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: vi.fn().mockReturnValue([]),
  addBinding: vi.fn(),
  removeBinding: vi.fn().mockReturnValue(true),
  syncSecret: vi.fn().mockReturnValue({ updated: 0, errors: [] }),
  unsyncBinding: vi.fn(),
}))

vi.mock('../web/mcp-list.js', () => ({
  getMcpListCache: vi.fn().mockReturnValue([]),
  refreshMcpListCache: vi.fn(),
  purgeFromMcpListCache: vi.fn(),
}))

vi.mock('../web/routes/connectors-mcp.js', () => ({
  tryHandleMcpConnectors: vi.fn().mockResolvedValue(false),
}))

vi.mock('../mcp-list-parser.js', () => ({
  parseMcpListOutput: vi.fn().mockReturnValue([]),
}))

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(method: string, path: string, body?: object): {
  ctx: RouteContext
  out: { status: number; body: Record<string, unknown> }
} {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
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

import { tryHandleConnectors } from '../web/routes/connectors.js'
import { execSync } from 'node:child_process'

const mockExecSync = vi.mocked(execSync)

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Catalog install 500 ───────────────────────────────────────────────────────

describe('POST /api/mcp-catalog/:id/install -- 500 error shape', () => {
  it('returns error token + 500 when execSync throws during install', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('install failed: permission denied') })
    const { ctx, out } = makeCtx('POST', '/api/mcp-catalog/test-connector/install')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(500)
    // error field must be a string (the err.message or fallback)
    expect(typeof out.body.error).toBe('string')
    expect(String(out.body.error).length).toBeGreaterThan(0)
  })

  it('returns fallback message when error has no .message', async () => {
    mockExecSync.mockImplementation(() => { const e = new Error(); e.message = ''; throw e })
    const { ctx, out } = makeCtx('POST', '/api/mcp-catalog/test-connector/install')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(500)
    expect(typeof out.body.error).toBe('string')
  })

  it('returns not_found + 404 when catalog item does not exist', async () => {
    const { ctx, out } = makeCtx('POST', '/api/mcp-catalog/no-such-item/install')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })
})

// ── Catalog uninstall 500 ─────────────────────────────────────────────────────

describe('DELETE /api/mcp-catalog/:id/uninstall -- 500 error shape', () => {
  it('returns error token + 500 when the outer try-catch fires during uninstall', async () => {
    // First execSync (user-scope removal) succeeds; second (project-scope) throws --
    // but the outer catch fires only when loadMcpCatalog itself throws.
    // Easiest trigger: make the readFileSync for the catalog throw.
    const { readFileSync } = await import('node:fs')
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('catalog read failed') })
    const { ctx, out } = makeCtx('DELETE', '/api/mcp-catalog/test-connector/uninstall')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(500)
    expect(typeof out.body.error).toBe('string')
  })

  it('returns not_found + 404 when catalog item does not exist', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/mcp-catalog/no-such-item/uninstall')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })
})

// ── Vault-binding no-targets ──────────────────────────────────────────────────

describe('POST /api/vault/bindings -- no-targets error shape', () => {
  it('returns invalid_value + serverName field + 400 when no targets found', async () => {
    // With listAgentNames=[], getExternalProjectPaths=[], readFileOr='{}' and
    // existsSync=false, no mcp.json will contain the requested server name.
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', {
      vaultSecretId: 'secret-abc',
      envVar: 'MY_API_KEY',
      serverName: 'non-existent-server',
    })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('serverName')
    // token must be snake_case
    expect(String(out.body.error)).toMatch(/^[a-z_]+$/)
  })
})

// ── Mutation verification ─────────────────────────────────────────────────────

describe('mutation: wrong error token would be caught', () => {
  it('test detects if not_found were returned as notFound', async () => {
    const { ctx, out } = makeCtx('POST', '/api/mcp-catalog/no-such-item/install')
    await tryHandleConnectors(ctx)
    expect(out.body.error).not.toBe('notFound')
    expect(out.body.error).toBe('not_found')
  })

  it('test detects if invalid_value were returned as invalidValue', async () => {
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', {
      vaultSecretId: 'secret-abc',
      envVar: 'MY_KEY',
      serverName: 'ghost-server',
    })
    await tryHandleConnectors(ctx)
    expect(out.body.error).not.toBe('invalidValue')
    expect(out.body.error).toBe('invalid_value')
  })
})
