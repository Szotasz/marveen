import { afterAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const harness = vi.hoisted(() => ({ calls: [] as { file: string; args: string[] }[] }))
const sandbox = mkdtempSync(join(resolve('.'), '.engine-pkg-'))
mkdirSync(join(sandbox, 'store'))
writeFileSync(join(sandbox, '.mcp.json'), JSON.stringify({
  mcpServers: { dashboard: { command: 'node', args: ['dashboard.mjs'] } },
}))
vi.mock('../config.js', async original => ({
  ...await original<typeof import('../config.js')>(), PROJECT_ROOT: sandbox, STORE_DIR: join(sandbox, 'store'),
}))
vi.mock('../web/mcp-inheritance.js', async original => ({
  ...await original<typeof import('../web/mcp-inheritance.js')>(),
  readInheritableMcpServerNames: () => new Set(['dashboard']),
}))
vi.mock('../web/agent-process.js', async original => ({
  ...await original<typeof import('../web/agent-process.js')>(),
  isAgentRunning: () => false, agentHasChannel: () => false,
}))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  execFileSync: vi.fn((file: string, args: readonly string[] = []) => {
    harness.calls.push({ file, args: [...args] })
    return ''
  }),
}))
vi.mock('../platform.js', async original => ({
  ...await original<typeof import('../platform.js')>(),
  makeLazyBinResolver: (name: string) => () => name,
}))
vi.mock('../web/requeue-notice.js', () => ({ requeueAbandonedAndNotify: vi.fn() }))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(), notifyTelegram: vi.fn() }))

const { tryHandleAgents } = await import('../web/routes/agents.js')
const { agentDir, readAgentEngineConfig } = await import('../web/agent-config.js')
const { startAgentProcess } = await import('../web/agent-process.js')
afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

async function request(path: string, method: string, body: unknown): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  Object.assign(req, { headers: {}, url: path })
  const result = { status: 0, body: null as any }
  const res = {
    writeHead(status: number) { result.status = status; return res },
    end(chunk?: string) { if (chunk) result.body = JSON.parse(chunk) }, setHeader() {},
  }
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  await tryHandleAgents({ req, res, path, method, url: new URL(path, 'http://localhost'), auth: { kind: 'session' } } as unknown as RouteContext, sandbox)
  return result
}

function packageFixture(name: string, manifest = true): string {
  const dir = agentDir(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), '@PACKAGE.md\n\n' + '@LOCAL.md\n# Shell rest\n')
  writeFileSync(join(dir, 'PACKAGE.md'), '# Package layer\n')
  if (manifest) {
    writeFileSync(join(dir, 'LOCAL.md'), '# Local layer\n')
    mkdirSync(join(dir, '.package'))
    writeFileSync(join(dir, '.package', 'manifest.json'), '{"name":"fixture-package"}\n')
  }
  return dir
}

async function expectPackagePutRefused(name: string, manifest: boolean): Promise<void> {
  const dir = packageFixture(name, manifest)
  const before = readFileSync(join(dir, 'CLAUDE.md'))
  const home = join(sandbox, 'pkg-home')
  const response = await request(`/api/agents/${name}`, 'PUT', { engine: 'codex', codexConfigDir: home })
  expect(response.status).toBe(400)
  expect(response.body.error).toContain('cannot be package agents')
  expect(existsSync(join(dir, 'agent-config.json'))).toBe(false)
  expect(existsSync(home)).toBe(false)
  expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
  expect(readFileSync(join(dir, 'CLAUDE.md'))).toEqual(before)
}

describe('package agent engine API', () => {
  it('PKG1 PUT refuses engine codex for a package agent before any write', async () => {
    await expectPackagePutRefused('package-agent', true)
  })

  it('PKG2 PUT refuses engine codex when only the CLAUDE.md shell marks the package agent', async () => {
    await expectPackagePutRefused('shell-agent', false)
  })

  it('PKG3 PUT still accepts engine codex for a plain agent', async () => {
    const name = 'plain-agent'
    const dir = agentDir(name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '# Plain agent\n')
    const response = await request(`/api/agents/${name}`, 'PUT', {
      engine: 'codex', codexConfigDir: join(sandbox, 'plain-home'),
    })
    expect(response.status).toBe(200)
    expect(readAgentEngineConfig(name).engine).toBe('codex')
  })

  it('PKG4 PUT accepts a CLAUDE.md that only mentions PACKAGE.md later', async () => {
    const name = 'mention-agent'
    const dir = agentDir(name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'CLAUDE.md'), '# Plain agent\nSee @PACKAGE.md for nothing.\n')
    const response = await request(`/api/agents/${name}`, 'PUT', {
      engine: 'codex', codexConfigDir: join(sandbox, 'mention-home'),
    })
    expect(response.status).toBe(200)
  })
})

describe('package agent engine start', () => {
  it('PKG5 start refuses a package agent configured for codex before launching anything', async () => {
    const name = 'start-package'
    const dir = packageFixture(name)
    writeFileSync(join(dir, 'agent-config.json'), JSON.stringify({
      engine: 'codex', codexConfigDir: join(sandbox, 'pkg-start-home'),
    }))
    harness.calls.length = 0
    const result = await startAgentProcess(name)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('cannot be package agents')
    expect(harness.calls.filter(call => call.file === 'tmux' && call.args.includes('new-session'))).toHaveLength(0)
    expect(harness.calls.filter(call => call.file === 'bash' && call.args[0] === join(sandbox, 'scripts/codex-agent.sh'))).toHaveLength(0)
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
  })
})
