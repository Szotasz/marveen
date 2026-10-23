import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

const tmpRoot = mkdtempSync(join(tmpdir(), 'connectors-mcp-cli-'))

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

writeFileSync(join(tmpRoot, 'mcp-catalog.json'), JSON.stringify([
  { id: 'fake-local', name: 'Fake local', type: 'local', command: 'npx', args: ['-y', 'pkg@1'], env: { API_MODE: 'ro', API_KEY: '' } },
  { id: 'fake-remote', name: 'Fake remote', type: 'remote', url: 'https://example.test/mcp?x=1&y=$(id)', transport: 'http' },
  { id: 'fake-sse', name: 'Fake sse', type: 'remote', url: 'https://example.test/sse' },
]))

// The fake must win on PATH before connectors.js (and mcp-list.ts) are imported.
const binDir = mkdtempSync(join(tmpdir(), 'connectors-mcp-bin-'))
writeFileSync(join(binDir, 'claude'), `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
n=$(cat "$d/n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$d/n"
for a in "$@"; do printf '%s\\n' "$a"; done > "$d/argv.$n"
echo "start $n" >> "$d/events"
cat > "$d/stdin.$n"
if [ -f "$d/sleep" ]; then sleep "$(cat "$d/sleep")"; fi
if [ -f "$d/fail" ] && grep -qxF -- "$(cat "$d/fail")" "$d/argv.$n"; then echo "fake claude failure: $*" >&2; exit 1; fi
echo "end $n" >> "$d/events"
exit 0
`)
chmodSync(join(binDir, 'claude'), 0o755)
const origPath = process.env.PATH
process.env.PATH = `${binDir}:${origPath}`

const { tryHandleConnectors } = await import('../web/routes/connectors.js')

afterAll(() => {
  process.env.PATH = origPath
  delete process.env.FAKE_CLAUDE_DIR
  rmSync(binDir, { recursive: true, force: true })
  rmSync(tmpRoot, { recursive: true, force: true })
})

const SLEEP_S = 1.5
const STALL_MAX_MS = 750

// A stall that starts right at enable() goes unseen, so the meter gets a few samples in first.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { await sleep(30); await fn(); await sleep(50) } finally { h.disable() }
  return h.max / 1e6
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  process.env.FAKE_CLAUDE_DIR = dir
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function argvOf(n: number): string[] {
  const lines = readFileSync(join(dir, `argv.${n}`), 'utf-8').split('\n')
  lines.pop()
  return lines
}
function callCount(): number {
  try { return Number(readFileSync(join(dir, 'n'), 'utf-8').trim()) } catch { return 0 }
}
function events(): string[] { try { return readFileSync(join(dir, 'events'), 'utf-8').split('\n').filter(Boolean) } catch { return [] } }
const setSleep = (v: string = String(SLEEP_S)) => writeFileSync(join(dir, 'sleep'), v)
const setFail = (v: string) => writeFileSync(join(dir, 'fail'), v)

async function call(method: string, path: string, body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} })
  let status = 0
  let out = ''
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL('http://localhost' + path)
  await tryHandleConnectors({ req, res, path: url.pathname, method, url } as any)
  return { status, json: out ? JSON.parse(out) : null }
}

const HTTP_BODY = { name: 'my http', type: 'http', url: 'https://example.test/a?b=1&c=$(id)' }

describe('claude mcp CLI is async and shell-free', () => {
  it('instrument positive control', async () => {
    const stall = await stallDuring(async () => { const t = Date.now(); while (Date.now() - t < 300); })
    expect(stall).toBeGreaterThanOrEqual(250)
  })

  it('POST http connector', async () => {
    setSleep()
    let r: any
    const t = Date.now()
    const stall = await stallDuring(async () => { r = await call('POST', '/api/connectors', HTTP_BODY) })
    const elapsed = Date.now() - t
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.name).toBe('my-http')
    expect(argvOf(1)).toEqual(['mcp', 'add', '--transport', 'http', '-s', 'user', 'my-http', 'https://example.test/a?b=1&c=$(id)'])
    expect(stall).toBeLessThan(STALL_MAX_MS)
    expect(elapsed).toBeGreaterThanOrEqual(SLEEP_S * 1000 - 100)
  })

  it('POST sse connector with project scope', async () => {
    setSleep('0')
    await call('POST', '/api/connectors', { name: 'sse one', type: 'sse', url: 'https://example.test/s', scope: 'project' })
    expect(argvOf(1)).toEqual(['mcp', 'add', '--transport', 'sse', '-s', 'project', 'sse-one', 'https://example.test/s'])
  })

  it('POST stdio connector', async () => {
    setSleep()
    let r: any
    const stall = await stallDuring(async () => {
      r = await call('POST', '/api/connectors', { name: 'local1', type: 'stdio', command: 'node', args: '  server.js   --port 9  ' })
    })
    expect(r.status).toBe(200)
    expect(argvOf(1)).toEqual(['mcp', 'add', '-s', 'user', 'local1', '--', 'node', 'server.js', '--port', '9'])
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('POST failure surfaces CLI output', async () => {
    setSleep('0'); setFail('add')
    const r = await call('POST', '/api/connectors', HTTP_BODY)
    expect(r.status).toBe(500)
    expect(r.json.error).toContain('Command failed')
    expect(r.json.error).toContain('fake claude failure')
  })

  it('catalog install local', async () => {
    setSleep()
    let r: any
    const stall = await stallDuring(async () => { r = await call('POST', '/api/mcp-catalog/fake-local/install', {}) })
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(r.json.message).toBe('Telepítve')
    expect(argvOf(1)).toEqual(['mcp', 'add', '--scope', 'user', 'fake-local', '-e', 'API_MODE=ro', '--', 'npx', '-y', 'pkg@1'])
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('catalog install remote http', async () => {
    setSleep('0')
    await call('POST', '/api/mcp-catalog/fake-remote/install', {})
    expect(argvOf(1)).toEqual(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'fake-remote', 'https://example.test/mcp?x=1&y=$(id)'])
  })

  it('catalog install remote sse default', async () => {
    setSleep('0')
    await call('POST', '/api/mcp-catalog/fake-sse/install', {})
    expect(argvOf(1)).toEqual(['mcp', 'add', '--transport', 'sse', '--scope', 'user', 'fake-sse', 'https://example.test/sse'])
  })

  it('catalog install failure', async () => {
    setSleep('0'); setFail('add')
    const r = await call('POST', '/api/mcp-catalog/fake-remote/install', {})
    expect(r.status).toBe(500)
    expect(r.json.error).toContain('fake claude failure')
  })

  it('uninstall', async () => {
    setSleep()
    let r: any
    const stall = await stallDuring(async () => { r = await call('DELETE', '/api/mcp-catalog/fake-local/uninstall') })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, message: 'Eltávolítva' })
    expect(callCount()).toBe(1)
    expect(argvOf(1)).toEqual(['mcp', 'remove', 'fake-local', '-s', 'user'])
    expect(stall).toBeLessThan(STALL_MAX_MS)
  })

  it('uninstall falls back to project scope', async () => {
    setSleep('0'); setFail('user')
    const r = await call('DELETE', '/api/mcp-catalog/fake-local/uninstall')
    expect(r.status).toBe(200)
    expect(callCount()).toBe(2)
    expect(argvOf(2)).toEqual(['mcp', 'remove', 'fake-local', '-s', 'project'])
  })

  it('uninstall ignores failure in both scopes', async () => {
    setSleep('0'); setFail('remove')
    const r = await call('DELETE', '/api/mcp-catalog/fake-local/uninstall')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(callCount()).toBe(2)
  })

  it('stdin is closed', async () => {
    setSleep('0')
    const r = await Promise.race([call('POST', '/api/connectors', HTTP_BODY), sleep(3000).then(() => 'hung' as const)])
    expect(r).not.toBe('hung')
    expect((r as { status: number }).status).toBe(200)
  }, 10_000)

  it('two overlapping requests run the CLI one at a time', async () => {
    setSleep('1')
    const [a, b] = await Promise.all([
      call('POST', '/api/connectors', { name: 'one', type: 'http', url: 'https://example.test/1' }),
      call('POST', '/api/connectors', { name: 'two', type: 'http', url: 'https://example.test/2' }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(callCount()).toBe(2)
    let open = 0, worst = 0
    for (const e of events()) {
      if (e.startsWith('start ')) worst = Math.max(worst, ++open)
      else if (e.startsWith('end ')) open--
    }
    expect(worst).toBe(1)
  })

  it('an argument the OS cannot take (a NUL byte) answers 500 and runs no CLI', async () => {
    setSleep('0')
    const r = await call('POST', '/api/connectors', { name: 'nul', type: 'http', url: 'https://example.test/a\u0000b' })
    expect(r.status).toBe(500)
    expect(callCount()).toBe(0)
    const ok = await call('POST', '/api/connectors', { name: 'after', type: 'http', url: 'https://example.test/ok' })
    expect(ok.status).toBe(200)
    expect(callCount()).toBe(1)
  })

  it('an uninstall holds the CLI slot for both of its scopes, so an add of the same name cannot land between them', async () => {
    setSleep('1'); setFail('user')
    const del = call('DELETE', '/api/mcp-catalog/fake-local/uninstall')
    await vi.waitFor(() => expect(events()).toContain('start 1'), { timeout: 5000 })
    const add = call('POST', '/api/connectors', { name: 'fake-local', type: 'http', url: 'https://example.test/p', scope: 'project' })
    const [d, a] = await Promise.all([del, add])
    expect(d.status).toBe(200)
    expect(a.status).toBe(200)
    expect(callCount()).toBe(3)
    expect(argvOf(1)).toEqual(['mcp', 'remove', 'fake-local', '-s', 'user'])
    expect(argvOf(2)).toEqual(['mcp', 'remove', 'fake-local', '-s', 'project'])
    expect(argvOf(3)).toEqual(['mcp', 'add', '--transport', 'http', '-s', 'project', 'fake-local', 'https://example.test/p'])
  })

  it('a connector DELETE waits for a running claude mcp add before rewriting the config', async () => {
    const name = 'del-serial-1'
    const file = join(tmpRoot, '.mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { command: 'x' } } }))
    setSleep('1')
    const add = call('POST', '/api/connectors', { name: 'busy-add', type: 'http', url: 'https://example.test/busy' })
    await vi.waitFor(() => expect(events()).toContain('start 1'), { timeout: 5000 })
    const del = call('DELETE', '/api/connectors/' + encodeURIComponent(name))
    await sleep(300)
    expect(readFileSync(file, 'utf-8')).toContain(name)
    expect(events()).not.toContain('end 1')
    const [a, d] = await Promise.all([add, del])
    expect(a.status).toBe(200)
    expect(d.status).toBe(200)
    expect(d.json).toEqual({ ok: true, removed: 1 })
    expect(readFileSync(file, 'utf-8')).not.toContain(name)
  })

  it('a connector DELETE whose config file is unreadable does not block later CLI calls', async () => {
    const file = join(tmpRoot, '.mcp.json')
    writeFileSync(file, '{not json')
    try {
      setSleep('0')
      const d = await call('DELETE', '/api/connectors/del-missing-2')
      expect(d.status).toBe(404)
      const r = await call('POST', '/api/connectors', HTTP_BODY)
      expect(r.status).toBe(200)
      expect(callCount()).toBe(1)
    } finally {
      writeFileSync(file, '{}')
    }
  })

  it('a non-string value (url: {}) answers 500 and runs no CLI, as the shell form did', async () => {
    setSleep('0')
    const r = await call('POST', '/api/connectors', { name: 'obj', type: 'http', url: {} })
    expect(r.status).toBe(500)
    expect(callCount()).toBe(0)
  })
})
