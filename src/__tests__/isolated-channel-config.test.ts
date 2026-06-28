import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, readlinkSync, readFileSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Redirect homedir() (used inside ensureIsolatedChannelConfigDir to find the
// shared ~/.claude) and agentDir() (used to find the agent cwd) at the temp
// sandbox built per test. tmpdir() stays real so we can create the sandbox.
let SANDBOX = ''
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})

// Imported AFTER the mocks are registered.
const { ensureIsolatedChannelConfigDir, CHANNEL_PLUGIN_IDS } = await import('../web/agent-process.js')
const TG = CHANNEL_PLUGIN_IDS.telegram
const SL = CHANNEL_PLUGIN_IDS.slack
const DI = CHANNEL_PLUGIN_IDS.discord

function seedSharedClaude(home: string) {
  const claude = join(home, '.claude')
  mkdirSync(claude, { recursive: true })
  // shared top-level entries; projects/ must end up symlinked (transcripts),
  // .credentials.json must NOT (auth comes from CLAUDE_CODE_OAUTH_TOKEN env).
  writeFileSync(join(claude, '.credentials.json'), '{"claudeAiOauth":{}}')
  mkdirSync(join(claude, 'projects'), { recursive: true })
  // settings.json must be OWNED (copied), not symlinked
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ hooks: { Stop: [] }, enabledPlugins: { [TG]: true } }))
  // plugins/: cache+marketplaces+data symlinked, install state owned
  const plugins = join(claude, 'plugins')
  mkdirSync(join(plugins, 'cache'), { recursive: true })
  mkdirSync(join(plugins, 'marketplaces'), { recursive: true })
  mkdirSync(join(plugins, 'data'), { recursive: true })
  writeFileSync(join(plugins, 'known_marketplaces.json'), '{"claude-plugins-official":{}}')
  writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      [TG]: [{ scope: 'project', projectPath: '/some/other/agent', installPath: '/x', version: '0.0.6' }],
    },
  }))
}

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'isocfg-'))
  seedSharedClaude(join(SANDBOX, 'home'))
  mkdirSync(join(SANDBOX, 'agents', 'testagent'), { recursive: true })
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('ensureIsolatedChannelConfigDir', () => {
  it('returns the per-agent .claude-config path', () => {
    const cfg = ensureIsolatedChannelConfigDir('testagent', 'telegram')
    expect(cfg).toBe(join(SANDBOX, 'agents', 'testagent', '.claude-config'))
  })

  it('symlinks shared transcripts so --continue stays shared', () => {
    const cfg = ensureIsolatedChannelConfigDir('testagent', 'telegram')!
    expect(lstatSync(join(cfg, 'projects')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(cfg, 'projects'))).toBe(join(SANDBOX, 'home', '.claude', 'projects'))
  })

  it('does NOT symlink or copy .credentials.json (auth via CLAUDE_CODE_OAUTH_TOKEN env)', () => {
    // Szotasz #459 review: a symlinked .credentials.json breaks on the first
    // atomic token refresh (temp+rename replaces the link, diverging the creds
    // and racing the single-use refresh token). The isolated dir must carry NO
    // credentials file at all -- the launcher injects a long-lived OAuth token.
    const cfg = ensureIsolatedChannelConfigDir('testagent', 'telegram')!
    expect(existsSync(join(cfg, '.credentials.json'))).toBe(false)
  })

  it('removes a stale .credentials.json left by an older build', () => {
    const cfg = join(SANDBOX, 'agents', 'testagent', '.claude-config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, '.credentials.json'), '{"stale":true}')
    ensureIsolatedChannelConfigDir('testagent', 'telegram')
    expect(existsSync(join(cfg, '.credentials.json'))).toBe(false)
  })

  it('OWNS settings.json (real file) with only the agent provider plugin enabled', () => {
    const cfg = ensureIsolatedChannelConfigDir('testagent', 'telegram')!
    const sp = join(cfg, 'settings.json')
    expect(lstatSync(sp).isSymbolicLink()).toBe(false)
    const s = JSON.parse(readFileSync(sp, 'utf-8'))
    expect(s.enabledPlugins[TG]).toBe(true)
    expect(s.enabledPlugins[SL]).toBe(false)
    expect(s.enabledPlugins[DI]).toBe(false)
    expect(s.hooks).toEqual({ Stop: [] }) // shared non-plugin settings preserved
  })

  it('a slack agent enables ONLY slack in its isolated settings', () => {
    const cfg = ensureIsolatedChannelConfigDir('testagent', 'slack')!
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(s.enabledPlugins[SL]).toBe(true)
    expect(s.enabledPlugins[TG]).toBe(false)
  })

  it('OWNS plugins/installed_plugins.json re-pointed at this agent cwd, symlinks the cache', () => {
    const cfg = ensureIsolatedChannelConfigDir('testagent', 'telegram')!
    expect(lstatSync(join(cfg, 'plugins', 'cache')).isSymbolicLink()).toBe(true)
    const ip = join(cfg, 'plugins', 'installed_plugins.json')
    expect(lstatSync(ip).isSymbolicLink()).toBe(false)
    const inst = JSON.parse(readFileSync(ip, 'utf-8'))
    expect(inst.plugins[TG][0].projectPath).toBe(join(SANDBOX, 'agents', 'testagent'))
  })

  it('is idempotent: a second call leaves a valid isolated dir', () => {
    const first = ensureIsolatedChannelConfigDir('testagent', 'telegram')
    const second = ensureIsolatedChannelConfigDir('testagent', 'telegram')
    expect(second).toBe(first)
    expect(existsSync(join(second!, 'settings.json'))).toBe(true)
    expect(lstatSync(join(second!, 'plugins', 'cache')).isSymbolicLink()).toBe(true)
  })

  it('returns null (degraded, not fatal) when the shared ~/.claude is absent', () => {
    rmSync(join(SANDBOX, 'home', '.claude'), { recursive: true, force: true })
    expect(ensureIsolatedChannelConfigDir('testagent', 'telegram')).toBeNull()
  })
})

// Source-level contract for the launcher wiring (startAgentProcess). These
// guard the auth mechanism Szotasz asked for: no symlinked creds, a long-lived
// OAuth token injected via env, and isolation gated on that token's presence.
const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('isolated-config launcher wiring', () => {
  it('skips .credentials.json from the symlink set', () => {
    expect(SRC).toMatch(/ISOLATED_CONFIG_SKIP\s*=\s*new Set\(\[[^\]]*'\.credentials\.json'/)
  })

  it('gates auto-isolation on the fleet OAuth token', () => {
    expect(SRC).toMatch(/if\s*\(hasFleetOauthToken\(\)\)/)
  })

  it('injects CLAUDE_CODE_OAUTH_TOKEN by reading the 0600 file at launch (secret never in the command string)', () => {
    expect(SRC).toMatch(/CLAUDE_CODE_OAUTH_TOKEN="\$\(cat '\$\{FLEET_OAUTH_TOKEN_PATH\}'\)"/)
    expect(SRC).toMatch(/\$\{oauthTokenEnv\}/)
  })

  it('falls back to the shared ~/.claude (no isolation) when the token is missing', () => {
    // The warning branch keeps the pre-isolation behaviour rather than launching
    // a logged-out sub-agent.
    expect(SRC).toMatch(/no fleet OAuth token/)
  })
})
