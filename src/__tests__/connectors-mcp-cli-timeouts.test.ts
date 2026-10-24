import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'

const tmpRoot = mkdtempSync(join(tmpdir(), 'connectors-mcp-cli-timeouts-'))
// The connector DELETE also rewrites ~/.claude.json: point HOME at a scratch
// dir so no test can read or rewrite the real one of whoever runs the suite.
const tmpHome = mkdtempSync(join(tmpdir(), 'connectors-mcp-home-timeouts-'))
const origHome = process.env.HOME
process.env.HOME = tmpHome

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot,
}))

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))

vi.mock('../web/vault.js', () => ({
  listSecrets: vi.fn(() => []),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn(() => null),
  getSecretsForEnv: vi.fn(() => ({})),
}))

// The route promisifies execFile and passes the timeout in its options: keep
// the real child running (the fake `claude` must really execute) while noting
// what every call was handed. vi.mock is hoisted, so the array has to be too.
const execFileCalls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; timeout: unknown }>)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const realCustom = (actual.execFile as any)[promisify.custom]
  const wrapped: any = (...a: any[]) => (actual.execFile as any)(...a)
  wrapped[promisify.custom] = (file: string, args: string[], opts: any) => {
    execFileCalls.push({ file, args: [...args], timeout: opts?.timeout })
    return realCustom(file, args, opts)
  }
  return { ...actual, execFile: wrapped }
})

writeFileSync(join(tmpRoot, 'mcp-catalog.json'), JSON.stringify([
  { id: 'fake-local', name: 'Fake local', type: 'local', command: 'npx', args: ['-y', 'pkg@1'], env: { API_MODE: 'ro', API_KEY: '' } },
  { id: 'fake-remote', name: 'Fake remote', type: 'remote', url: 'https://example.test/mcp?x=1&y=$(id)', transport: 'http' },
  { id: 'fake-sse', name: 'Fake sse', type: 'remote', url: 'https://example.test/sse' },
]))

// The fake must win on PATH before connectors.js (and mcp-list.ts) are imported.
const binDir = mkdtempSync(join(tmpdir(), 'connectors-mcp-bin-timeouts-'))
writeFileSync(join(binDir, 'claude'), `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
echo "$*" >> "$d/calls"
cat > /dev/null
if [ -f "$d/fail" ]; then f=$(cat "$d/fail"); for a in "$@"; do [ "$a" = "$f" ] && { echo "fake failure" >&2; exit 1; }; done; fi
exit 0
`)
chmodSync(join(binDir, 'claude'), 0o755)
const origPath = process.env.PATH
process.env.PATH = `${binDir}:${origPath}`

const { tryHandleConnectors } = await import('../web/routes/connectors.js')

afterAll(() => {
  process.env.PATH = origPath
  if (origHome === undefined) delete process.env.HOME
  else process.env.HOME = origHome
  rmSync(tmpHome, { recursive: true, force: true })
  delete process.env.FAKE_CLAUDE_DIR
  rmSync(binDir, { recursive: true, force: true })
  rmSync(tmpRoot, { recursive: true, force: true })
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-timeouts-'))
  process.env.FAKE_CLAUDE_DIR = dir
  execFileCalls.length = 0
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Only the `claude mcp add` / `claude mcp remove` calls the route makes; the
// `claude mcp list` refresh (mcp-list.ts) goes through the same execFile.
function mcpCalls(): Array<{ file: string; args: string[]; timeout: unknown }> {
  return execFileCalls.filter(c => c.file === 'claude' && c.args[0] === 'mcp' && (c.args[1] === 'add' || c.args[1] === 'remove'))
}

// What the fake CLI itself saw, as a cross-check that the recorded call ran.
function mcpLines(): string[] {
  try {
    return readFileSync(join(dir, 'calls'), 'utf-8').split('\n').filter(Boolean)
      .filter(l => l.startsWith('mcp add ') || l.startsWith('mcp remove '))
  } catch { return [] }
}

async function call(method: string, path: string, body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} })
  let status = 0
  let out = ''
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL('http://localhost' + path)
  await tryHandleConnectors({ req, res, path: url.pathname, method, url } as any)
  return { status, json: out ? JSON.parse(out) : null }
}

describe('claude mcp CLI calls carry a timeout', () => {
  it('a custom http connector add gets 15 s', async () => {
    const r = await call('POST', '/api/connectors', { name: 'tm http', type: 'http', url: 'https://example.test/t' })
    expect(r.status).toBe(200)
    const calls = mcpCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].args[1]).toBe('add')
    expect(calls[0].timeout).toBe(15000)
    expect(mcpLines()).toHaveLength(calls.length)
  })

  it('a custom stdio connector add gets 15 s', async () => {
    const r = await call('POST', '/api/connectors', { name: 'tmlocal', type: 'stdio', command: 'node', args: 'server.js' })
    expect(r.status).toBe(200)
    const calls = mcpCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].args[1]).toBe('add')
    expect(calls[0].timeout).toBe(15000)
    expect(mcpLines()).toHaveLength(calls.length)
  })

  it('a local catalog install gets 30 s', async () => {
    const r = await call('POST', '/api/mcp-catalog/fake-local/install', {})
    expect(r.status).toBe(200)
    const calls = mcpCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].args[1]).toBe('add')
    expect(calls[0].timeout).toBe(30000)
    expect(mcpLines()).toHaveLength(calls.length)
  })

  it('a remote catalog install gets 30 s', async () => {
    const r = await call('POST', '/api/mcp-catalog/fake-remote/install', {})
    expect(r.status).toBe(200)
    const calls = mcpCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].args[1]).toBe('add')
    expect(calls[0].timeout).toBe(30000)
    expect(mcpLines()).toHaveLength(calls.length)
  })

  it('an uninstall tries user scope once, with 15 s', async () => {
    const r = await call('DELETE', '/api/mcp-catalog/fake-local/uninstall')
    expect(r.status).toBe(200)
    const calls = mcpCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].args[1]).toBe('remove')
    expect(calls[0].args).toContain('user')
    expect(calls[0].timeout).toBe(15000)
    expect(mcpLines()).toHaveLength(calls.length)
  })

  it('a failed user-scope uninstall retries with project scope, both with 15 s', async () => {
    writeFileSync(join(dir, 'fail'), 'user')
    const r = await call('DELETE', '/api/mcp-catalog/fake-local/uninstall')
    expect(r.status).toBe(200)
    const calls = mcpCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0].args[1]).toBe('remove')
    expect(calls[0].args).toContain('user')
    expect(calls[1].args[1]).toBe('remove')
    expect(calls[1].args).toContain('project')
    expect(calls.map(c => c.timeout)).toEqual([15000, 15000])
    expect(mcpLines()).toHaveLength(calls.length)
  })
})
