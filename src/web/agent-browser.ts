// The agent's own browser (VAULTLOGIN1112). One Chrome per sub-agent that some vault web login allows:
//   - its own profile (store/agent-browser/<agent>/profile), never the owner's Chrome profile; Chrome refuses remote
//     debugging on its default data directory anyway;
//   - CDP on 127.0.0.1 only, on a port this module allocates and keeps (store/agent-browser/ports.json);
//   - the browser's password manager is OFF (profile preferences, written before every start), so a typed password is
//     never saved into the profile;
//   - a visible window where there is a display (the owner types a second factor there), headless on a Linux host
//     without one.
// The dashboard starts it (detached, so it survives a dashboard restart) and a watchdog restarts it when it is down.
// The agent reaches it through the Playwright MCP server attached over CDP (the marveen-browser entry this module
// writes into the agent's .mcp.json); the vault-login filler attaches to the same browser in the dashboard process.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync, writeMcpJsonFile } from './atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames, readJsonObjectForWrite } from './agent-config.js'
import { agentsWithWebLogins } from './vault-web-logins.js'

export const AGENT_BROWSER_MCP_NAME = 'marveen-browser'
/** The Playwright MCP version measured against this design (VAULTLOGIN1112 pre-measurement, 2026-11-23). */
export const PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.85'
const PORT_FIRST = 9400
const PORT_LAST = 9499

export function agentBrowserDir(agent: string): string {
  return join(STORE_DIR, 'agent-browser', agent)
}
export function agentBrowserProfileDir(agent: string): string {
  return join(agentBrowserDir(agent), 'profile')
}
/** The Playwright MCP server's output folder (snapshots, console logs): its own, short-lived, emptied by vault-login. */
export function agentBrowserOutputDir(agent: string): string {
  return join(agentBrowserDir(agent), 'mcp-out')
}
function portsFile(): string {
  return join(STORE_DIR, 'agent-browser', 'ports.json')
}

function readPorts(): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(portsFile(), 'utf-8')) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, number> = {}
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
      if (Number.isInteger(p) && (p as number) >= PORT_FIRST && (p as number) <= PORT_LAST) out[k] = p as number
    }
    return out
  } catch {
    return {}
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/** The agent's CDP port: the one it already has, or the first free one of the range, kept from then on. */
export async function agentBrowserPort(agent: string): Promise<number> {
  const ports = readPorts()
  if (ports[agent]) return ports[agent]
  const taken = new Set(Object.values(ports))
  for (let p = PORT_FIRST; p <= PORT_LAST; p++) {
    if (taken.has(p)) continue
    if (!(await portFree(p))) continue
    ports[agent] = p
    mkdirSync(join(STORE_DIR, 'agent-browser'), { recursive: true })
    atomicWriteFileSync(portsFile(), JSON.stringify(ports, null, 2) + '\n')
    return p
  }
  throw new Error('no free port for the agent browser')
}

export function chromeExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const override = env.AGENT_BROWSER_CHROME?.trim()
  const candidates = override
    ? [override]
    : platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((c) => existsSync(c)) ?? null
}

/** The launch arguments. Pure, so the test pins: own profile, loopback-only CDP, no first-run UI, headless only without a display. */
export function agentBrowserArgs(profileDir: string, port: number, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
  ]
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) args.push('--headless=new')
  args.push('about:blank')
  return args
}

/** The profile's password manager off, merged into whatever preferences the profile already has. */
export function writePasswordManagerOff(profileDir: string): void {
  const prefsPath = join(profileDir, 'Default', 'Preferences')
  mkdirSync(join(profileDir, 'Default'), { recursive: true })
  let prefs: Record<string, unknown> = {}
  try { prefs = JSON.parse(readFileSync(prefsPath, 'utf-8')) as Record<string, unknown> } catch { prefs = {} }
  const profile = (prefs.profile && typeof prefs.profile === 'object' ? prefs.profile : {}) as Record<string, unknown>
  prefs.credentials_enable_service = false
  prefs.profile = { ...profile, password_manager_enabled: false }
  atomicWriteFileSync(prefsPath, JSON.stringify(prefs))
}

export async function cdpUp(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch {
    return false
  }
}

/** The agent's browser running, started if it is not. Returns the CDP endpoint, or null when it could not start. */
export async function ensureAgentBrowser(agent: string): Promise<string | null> {
  const port = await agentBrowserPort(agent)
  const endpoint = `http://127.0.0.1:${port}`
  if (await cdpUp(port)) return endpoint
  const chrome = chromeExecutable()
  if (!chrome) {
    logger.warn({ agent }, 'agent-browser: no Chrome or Chromium found (AGENT_BROWSER_CHROME sets the path)')
    return null
  }
  const profile = agentBrowserProfileDir(agent)
  mkdirSync(profile, { recursive: true })
  mkdirSync(agentBrowserOutputDir(agent), { recursive: true })
  writePasswordManagerOff(profile)
  const child = spawn(chrome, agentBrowserArgs(profile, port), { detached: true, stdio: 'ignore' })
  child.on('error', (err) => logger.warn({ agent, err: err.message }, 'agent-browser: start failed'))
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await cdpUp(port, 500)) {
      logger.info({ agent, port }, 'agent-browser: started')
      return endpoint
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  logger.warn({ agent, port }, 'agent-browser: did not answer on its CDP port')
  return null
}

/** The marveen-browser MCP server entry: the Playwright MCP attached to the agent's browser, with its own output folder. */
export function agentBrowserMcpConfig(agent: string, port: number): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', PLAYWRIGHT_MCP_PACKAGE, '--cdp-endpoint', `http://127.0.0.1:${port}`, '--output-dir', agentBrowserOutputDir(agent)],
  }
}

/**
 * Every sub-agent some web login allows gets the marveen-browser entry in its .mcp.json; every other one loses it.
 * The agent sees a change at its next start. Returns the agents whose file changed.
 */
export async function syncAgentBrowserMcp(): Promise<string[]> {
  const wanted = new Set(agentsWithWebLogins())
  const changed: string[] = []
  for (const agent of listAgentNames()) {
    const mcpPath = join(AGENTS_BASE_DIR, agent, '.mcp.json')
    if (!existsSync(join(AGENTS_BASE_DIR, agent))) continue
    let cfg: Record<string, unknown>
    try { cfg = readJsonObjectForWrite(mcpPath) } catch { continue }
    const servers = (cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {}) as Record<string, unknown>
    const has = Object.prototype.hasOwnProperty.call(servers, AGENT_BROWSER_MCP_NAME)
    if (wanted.has(agent)) {
      const entry = agentBrowserMcpConfig(agent, await agentBrowserPort(agent))
      if (has && JSON.stringify(servers[AGENT_BROWSER_MCP_NAME]) === JSON.stringify(entry)) continue
      cfg.mcpServers = { ...servers, [AGENT_BROWSER_MCP_NAME]: entry }
    } else {
      if (!has) continue
      const { [AGENT_BROWSER_MCP_NAME]: _gone, ...rest } = servers
      cfg.mcpServers = rest
    }
    writeMcpJsonFile(mcpPath, JSON.stringify(cfg, null, 2))
    changed.push(agent)
  }
  return changed
}

/**
 * The vault-login cleanup of the MCP output folder: every file written since `sinceMs` (a snapshot taken while the
 * password was in the page would be one) is deleted. Returns how many were removed.
 */
export function cleanOutputDirSince(dir: string, sinceMs: number): number {
  let removed = 0
  let names: string[]
  try { names = readdirSync(dir) } catch { return 0 }
  for (const name of names) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.mtimeMs >= sinceMs - 1000) {
        rmSync(p, { recursive: true, force: true })
        removed++
      }
    } catch { /* gone already */ }
  }
  return removed
}

let watchdog: NodeJS.Timeout | null = null

/** Keep every allowed agent's browser running (checked once a minute; the first check runs at once). */
export function startAgentBrowserWatchdog(intervalMs = 60_000): void {
  if (watchdog) return
  const tick = async (): Promise<void> => {
    for (const agent of agentsWithWebLogins()) {
      try { await ensureAgentBrowser(agent) } catch (err) {
        logger.warn({ agent, err: (err as Error).message }, 'agent-browser: watchdog could not ensure the browser')
      }
    }
  }
  void tick()
  watchdog = setInterval(() => { void tick() }, intervalMs)
  watchdog.unref?.()
}
