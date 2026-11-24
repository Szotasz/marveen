// VAULTLOGIN1112: the agent's own browser and its MCP wiring. Pinned: the launch arguments (own profile, CDP on
// loopback only, headless only without a display), the password manager off in the profile (merged, not replacing),
// the marveen-browser MCP entry added for an allowed agent and removed for every other one (their other servers
// kept), the output-folder cleanup by time, and the CDP port kept per agent.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync, chmodSync } from 'node:fs'
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
