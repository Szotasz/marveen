// VAULTLOGIN1112: the agent's own browser and its MCP wiring. Pinned: the launch arguments (own profile, CDP on
// loopback only, headless only without a display), the password manager off in the profile (merged, not replacing),
// the marveen-browser MCP entry added for an allowed agent and removed for every other one (their other servers
// kept), the output-folder cleanup by time, and the CDP port kept per agent.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync, chmodSync, symlinkSync, statSync, closeSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ store: '', agentsDir: '', agents: [] as string[], allowed: [] as string[] }))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), get STORE_DIR() { return h.store } }))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  get AGENTS_BASE_DIR() { return h.agentsDir },
  listAgentNames: () => [...h.agents],
}))
vi.mock('../web/vault-web-logins.js', () => ({ agentsWithWebLogins: () => [...h.allowed] }))
const warns = vi.hoisted(() => [] as { obj: Record<string, unknown>; msg: string }[])
vi.mock('../logger.js', async (orig) => {
  const real = (await orig<typeof import('../logger.js')>()).logger
  return { logger: new Proxy(real, { get: (t, k) => (k === 'warn' ? (obj: Record<string, unknown>, msg: string) => { warns.push({ obj, msg }) } : Reflect.get(t, k)) }) }
})

const ab = await import('../web/agent-browser.js')

beforeEach(() => {
  h.store = mkdtempSync(join(tmpdir(), 'ab-store-'))
  h.agentsDir = mkdtempSync(join(tmpdir(), 'ab-agents-'))
  h.agents = ['geri', 'dani']
  h.allowed = []
  for (const a of h.agents) mkdirSync(join(h.agentsDir, a), { recursive: true })
})

describe('launch arguments', () => {
  it('own profile, CDP on 127.0.0.1 only, the given port', () => {
    const args = ab.agentBrowserArgs('/p/profile', 9401, {}, 'darwin')
    expect(args).toContain('--user-data-dir=/p/profile')
    expect(args).toContain('--remote-debugging-port=9401')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args.some((a) => a.startsWith('--remote-debugging-address=') && a !== '--remote-debugging-address=127.0.0.1')).toBe(false)
  })
  it('a visible window where there is a display; headless only on Linux without one', () => {
    expect(ab.agentBrowserArgs('/p', 9401, {}, 'darwin')).not.toContain('--headless=new')
    expect(ab.agentBrowserArgs('/p', 9401, { DISPLAY: ':0' }, 'linux')).not.toContain('--headless=new')
    expect(ab.agentBrowserArgs('/p', 9401, {}, 'linux')).toContain('--headless=new')
  })
})

describe('the password manager is off in the profile', () => {
  it('written into an empty profile, and merged into existing preferences without losing them', () => {
    const p = join(h.store, 'prof')
    ab.writePasswordManagerOff(p)
    let prefs = JSON.parse(readFileSync(join(p, 'Default', 'Preferences'), 'utf-8'))
    expect(prefs.credentials_enable_service).toBe(false)
    expect(prefs.profile.password_manager_enabled).toBe(false)
    writeFileSync(join(p, 'Default', 'Preferences'), JSON.stringify({ credentials_enable_service: true, profile: { name: 'X', password_manager_enabled: true }, other: 1 }))
    ab.writePasswordManagerOff(p)
    prefs = JSON.parse(readFileSync(join(p, 'Default', 'Preferences'), 'utf-8'))
    expect(prefs).toMatchObject({ credentials_enable_service: false, profile: { name: 'X', password_manager_enabled: false }, other: 1 })
  })
})

describe('the marveen-browser MCP entry', () => {
  const mcp = (a: string) => JSON.parse(readFileSync(join(h.agentsDir, a, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, any> }

  it('an allowed agent gets it (CDP on its own port, its own output folder); its other servers stay', async () => {
    writeFileSync(join(h.agentsDir, 'geri', '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }))
    h.allowed = ['geri']
    expect(await ab.syncAgentBrowserMcp()).toEqual(['geri'])
    const e = mcp('geri').mcpServers[ab.AGENT_BROWSER_MCP_NAME]
    const port = await ab.agentBrowserPort('geri')
    expect(e.command).toBe('npx')
    expect(e.args).toEqual(['-y', ab.PLAYWRIGHT_MCP_PACKAGE, '--cdp-endpoint', `http://127.0.0.1:${port}`, '--output-dir', ab.agentBrowserOutputDir('geri')])
    expect(mcp('geri').mcpServers.other).toEqual({ command: 'x' })
    expect(existsSync(join(h.agentsDir, 'dani', '.mcp.json'))).toBe(false)
    // Idempotent: nothing changes on a second run.
    expect(await ab.syncAgentBrowserMcp()).toEqual([])
  })

  it('an agent no entry allows any more loses it; its other servers stay', async () => {
    h.allowed = ['geri']
    await ab.syncAgentBrowserMcp()
    const cfg = mcp('geri'); cfg.mcpServers.other = { command: 'y' }
    writeFileSync(join(h.agentsDir, 'geri', '.mcp.json'), JSON.stringify(cfg))
    h.allowed = []
    expect(await ab.syncAgentBrowserMcp()).toEqual(['geri'])
    expect(mcp('geri').mcpServers).toEqual({ other: { command: 'y' } })
  })

  it('the CDP port is kept per agent and two agents never share one', async () => {
    const g = await ab.agentBrowserPort('geri')
    const d = await ab.agentBrowserPort('dani')
    expect(g).not.toBe(d)
    expect(await ab.agentBrowserPort('geri')).toBe(g)
    expect(g).toBeGreaterThanOrEqual(9400)
    expect(g).toBeLessThanOrEqual(9499)
  })
})

describe('the output-folder cleanup', () => {
  it('removes what was written since the call started, keeps the older files', () => {
    const dir = join(h.store, 'out')
    mkdirSync(dir)
    const start = Date.now()
    writeFileSync(join(dir, 'new.yml'), 'x')
    writeFileSync(join(dir, 'old.yml'), 'x')
    const past = new Date(start - 5 * 60_000)
    utimesSync(join(dir, 'old.yml'), past, past)
    expect(ab.cleanOutputDirSince(dir, start)).toBe(1)
    expect(existsSync(join(dir, 'new.yml'))).toBe(false)
    expect(existsSync(join(dir, 'old.yml'))).toBe(true)
  })
  it('a missing folder is not an error', () => {
    expect(ab.cleanOutputDirSince(join(h.store, 'nope'), Date.now())).toBe(0)
  })
})

describe('ensureAgentBrowser: the start path', () => {
  // A fake "Chrome": records its argv and what the profile's preferences said at ITS start, then answers
  // /json/version on the CDP port for a few seconds. It proves the order: preferences written BEFORE the launch.
  function fakeChrome(): { exe: string; record: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ab-fake-chrome-'))
    const record = join(dir, 'record.json')
    const exe = join(dir, 'chrome')
    writeFileSync(exe, `#!${process.execPath}
const fs = require('fs'), http = require('http'), path = require('path')
const argv = process.argv.slice(2)
const prof = (argv.find(a => a.startsWith('--user-data-dir=')) || '').slice(16)
let prefs = null
try { prefs = JSON.parse(fs.readFileSync(path.join(prof, 'Default', 'Preferences'), 'utf8')) } catch (e) {}
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, prefs }))
const port = Number((argv.find(a => a.startsWith('--remote-debugging-port=')) || '').split('=')[1])
const srv = http.createServer((q, r) => { r.end('{"Browser":"Fake/1"}') }).listen(port, '127.0.0.1')
setTimeout(() => { srv.close(); process.exit(0) }, 4000)
`)
    chmodSync(exe, 0o755)
    return { exe, record }
  }

  it('starts the configured browser with the product arguments, the password manager already off in its profile', async () => {
    const { exe, record } = fakeChrome()
    const saved = process.env.AGENT_BROWSER_CHROME
    process.env.AGENT_BROWSER_CHROME = exe
    try {
      const endpoint = await ab.ensureAgentBrowser('geri')
      const port = await ab.agentBrowserPort('geri')
      expect(endpoint).toBe(`http://127.0.0.1:${port}`)
      const rec = JSON.parse(readFileSync(record, 'utf-8')) as { argv: string[]; prefs: any }
      expect(rec.argv).toEqual(ab.agentBrowserArgs(ab.agentBrowserProfileDir('geri'), port))
      expect(rec.prefs).toMatchObject({ credentials_enable_service: false, profile: { password_manager_enabled: false } })
      expect(existsSync(ab.agentBrowserOutputDir('geri'))).toBe(true)
      // Already up: no second start.
      writeFileSync(record, 'untouched')
      expect(await ab.ensureAgentBrowser('geri')).toBe(endpoint)
      expect(readFileSync(record, 'utf-8')).toBe('untouched')
    } finally {
      if (saved === undefined) delete process.env.AGENT_BROWSER_CHROME
      else process.env.AGENT_BROWSER_CHROME = saved
    }
  }, 20_000)

  it('no browser installed: null, nothing started', async () => {
    const saved = process.env.AGENT_BROWSER_CHROME
    process.env.AGENT_BROWSER_CHROME = join(h.store, 'no-such-chrome')
    try {
      expect(await ab.ensureAgentBrowser('dani')).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.AGENT_BROWSER_CHROME
      else process.env.AGENT_BROWSER_CHROME = saved
    }
  })
})

// KOKAIVAULTSSO1127: a failed start said only "did not answer on its CDP port"; Chrome's stderr went to /dev/null.
describe('start failure diagnosis', () => {
  it('names the missing sandbox (Ubuntu 23.10+ AppArmor userns) with its fix', () => {
    const f = ab.chromeStartFailure('[1127/101010.1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! Update your kernel or see ...\n')
    expect(f.reason).toMatch(/no usable sandbox/i)
    expect(f.reason).toMatch(/AGENT_BROWSER_CHROME/)
    expect(f.lines).toHaveLength(1)
    expect(f.lines[0]).toMatch(/FATAL/)
  })
  it('passes only error-looking lines, at most five, each capped', () => {
    const noise = Array.from({ length: 20 }, (_, i) => `[INFO] visiting https://example.org/page?token=secret${i}`).join('\n')
    const errs = Array.from({ length: 7 }, (_, i) => `ERROR: thing ${i} ${'x'.repeat(400)}`).join('\n')
    const f = ab.chromeStartFailure(`${noise}\n${errs}`)
    expect(f.lines).toHaveLength(5)
    expect(f.lines.every((l) => l.startsWith('ERROR') && l.length <= 300)).toBe(true)
    expect(f.lines.join('\n')).not.toContain('token=secret')
    expect(f.reason).toMatch(/exited or did not open/)
  })
  it('says so when stderr was empty', () => {
    expect(ab.chromeStartFailure('').reason).toMatch(/no error on stderr/)
    expect(ab.chromeStartFailure('').lines).toEqual([])
  })
  it('keeps the stderr log in the agent\'s own browser folder', () => {
    expect(ab.agentBrowserStderrPath('geri')).toBe(join(h.store, 'agent-browser', 'geri', 'chrome-stderr.log'))
  })
})

describe('a real failed start reaches the log with Chrome\'s own words', () => {
  it('a browser that dies with "No usable sandbox!" is named in the warning, and its stderr is in the agent folder', async () => {
    const fake = join(mkdtempSync(join(tmpdir(), 'ab-fake-')), 'chrome')
    writeFileSync(fake, '#!/bin/sh\necho "[1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! see crbug.com/638180" >&2\nexit 1\n')
    chmodSync(fake, 0o755)
    const prev = process.env.AGENT_BROWSER_CHROME
    process.env.AGENT_BROWSER_CHROME = fake
    warns.length = 0
    try {
      expect(await ab.ensureAgentBrowser('geri')).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.AGENT_BROWSER_CHROME
      else process.env.AGENT_BROWSER_CHROME = prev
    }
    const w = warns.find((x) => x.msg.startsWith('agent-browser: did not answer on its CDP port'))
    expect(w?.msg).toMatch(/no usable sandbox/i)
    expect(JSON.stringify(w?.obj.stderr)).toMatch(/No usable sandbox/)
    expect(readFileSync(ab.agentBrowserStderrPath('geri'), 'utf-8')).toMatch(/No usable sandbox/)
  }, 30_000)
})

// Dani, #3194 review: the stderr file must not be opened through a symlink, and must be 0600 even when it existed.
describe('the stderr log file is opened safely', () => {
  it('refuses a symlink planted at the path: the target is not truncated or written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-link-'))
    const target = join(dir, 'victim.txt')
    writeFileSync(target, 'keep me')
    const link = join(dir, 'chrome-stderr.log')
    symlinkSync(target, link)
    expect(ab.openStderrLog(link)).toBeNull()
    expect(readFileSync(target, 'utf-8')).toBe('keep me')
  })
  it('an existing loose file becomes 0600 and is truncated', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ab-loose-')), 'chrome-stderr.log')
    writeFileSync(p, 'old content')
    chmodSync(p, 0o644)
    const fd = ab.openStderrLog(p)
    expect(fd).not.toBeNull()
    writeSync(fd as number, 'new')
    closeSync(fd as number)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readFileSync(p, 'utf-8')).toBe('new')
  })
})

describe('error lines carry no URL detail', () => {
  it('keeps scheme and host, drops userinfo, path, query', () => {
    const f = ab.chromeStartFailure('ERROR: load failed https://user:pass@idp.example.com/cb?code=abc&access_token=xyz#frag\n')
    expect(f.lines[0]).toContain('https://idp.example.com/<redacted>')
    expect(f.lines[0]).not.toMatch(/user:pass|code=abc|access_token|frag/)
  })
  it('a "TypeError" line is not an ERROR line by itself', () => {
    expect(ab.chromeStartFailure('TypeError: something at https://x.example/a?t=1\n').lines).toEqual([])
  })
})
