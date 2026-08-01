import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Same sandbox shape as isolated-channel-config.test.ts: homedir() and
// agentDir() are redirected into a throwaway temp tree, so nothing here can
// read or write the real ~/.claude of the machine running the suite.
let SANDBOX = ''
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(SANDBOX, 'agents', name) }
})

const { ensureIsolatedChannelConfigDir } = await import('../web/agent-process.js')

const AGENT = 'testagent'

function sharedDotClaude(): string { return join(SANDBOX, 'home', '.claude.json') }
function isolatedDotClaude(): string {
  return join(SANDBOX, 'agents', AGENT, '.claude-config', '.claude.json')
}
function writeShared(servers: Record<string, unknown>): void {
  writeFileSync(sharedDotClaude(), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers }, null, 2))
}
function readIsolated(): Record<string, unknown> {
  return JSON.parse(readFileSync(isolatedDotClaude(), 'utf-8')) as Record<string, unknown>
}
function servers(): Record<string, unknown> {
  return (readIsolated().mcpServers ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'mcpseed-'))
  const claude = join(SANDBOX, 'home', '.claude')
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
  mkdirSync(join(SANDBOX, 'agents', AGENT), { recursive: true })
  writeShared({ gmail: { command: 'npx', args: ['gmail-mcp'] } })
})
afterEach(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('isolated config dir: mcpServers reconcile', () => {
  it('propagates a server added to the shared config AFTER the dir was provisioned', () => {
    // First provision: the isolated dir is seeded from the shared config.
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(Object.keys(servers())).toEqual(['gmail'])

    // The operator adds a second server to the shared config, as when rolling
    // one out to a running fleet.
    writeShared({
      gmail: { command: 'npx', args: ['gmail-mcp'] },
      'google-drive': { command: 'npx', args: ['gdrive-mcp'] },
    })

    // Re-provision, i.e. the agent restarts. THIS is the regression from #834:
    // before the fix the new server never arrived here.
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(Object.keys(servers()).sort()).toEqual(['gmail', 'google-drive'])
    expect(servers()['google-drive']).toEqual({ command: 'npx', args: ['gdrive-mcp'] })
  })

  it('never overwrites an entry that already exists in the isolated config', () => {
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')

    // Claude Code (or a deliberate per-agent scoping decision) evolves the
    // entry: same key, different definition.
    const cur = readIsolated()
    cur.mcpServers = { gmail: { command: 'npx', args: ['gmail-mcp'], env: { SCOPE: 'agent-local' } } }
    writeFileSync(isolatedDotClaude(), JSON.stringify(cur, null, 2))

    // The shared config still carries its own, different definition of `gmail`.
    writeShared({
      gmail: { command: 'npx', args: ['gmail-mcp'] },
      'google-drive': { command: 'npx', args: ['gdrive-mcp'] },
    })
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')

    // The evolved entry survives untouched, and the genuinely missing one is added.
    expect(servers().gmail).toEqual({ command: 'npx', args: ['gmail-mcp'], env: { SCOPE: 'agent-local' } })
    expect(servers()['google-drive']).toEqual({ command: 'npx', args: ['gdrive-mcp'] })
  })

  it('leaves a server removed from the shared config in place (additive only)', () => {
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    writeShared({})
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(Object.keys(servers())).toEqual(['gmail'])
  })

  it('does not touch a non-object mcpServers instead of repairing it', () => {
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    const cur = readIsolated()
    cur.mcpServers = 'corrupted-by-something-else'
    writeFileSync(isolatedDotClaude(), JSON.stringify(cur, null, 2))

    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(readIsolated().mcpServers).toBe('corrupted-by-something-else')
  })

  it('preserves unrelated keys and keeps hasCompletedOnboarding set', () => {
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    const cur = readIsolated()
    cur.projects = { '/some/path': { hasTrustDialogAccepted: true } }
    cur.hasCompletedOnboarding = false
    writeFileSync(isolatedDotClaude(), JSON.stringify(cur, null, 2))

    writeShared({ gmail: { command: 'npx', args: ['gmail-mcp'] }, extra: { command: 'x' } })
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')

    const after = readIsolated()
    expect(after.projects).toEqual({ '/some/path': { hasTrustDialogAccepted: true } })
    expect(after.hasCompletedOnboarding).toBe(true)
    expect(Object.keys(after.mcpServers as object).sort()).toEqual(['extra', 'gmail'])
  })

  it('keeps an 0600 config at 0600 across a reconcile', () => {
    // tmp + rename replaces the inode, so without an explicit mode the new file
    // takes the umask default and a 0600 config silently relaxes to 0644. The
    // mcpServers entries carry env blocks with credentials, and this reconcile
    // is the path that rewrites the file regularly.
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    chmodSync(isolatedDotClaude(), 0o600)
    expect(statSync(isolatedDotClaude()).mode & 0o777).toBe(0o600)

    writeShared({ gmail: { command: 'npx', args: ['gmail-mcp'] }, 'google-drive': { command: 'npx' } })
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')

    // The reconcile really did run (otherwise the mode assertion proves nothing).
    expect(Object.keys(servers()).sort()).toEqual(['gmail', 'google-drive'])
    expect(statSync(isolatedDotClaude()).mode & 0o777).toBe(0o600)
  })

  it('preserves a deliberately wider mode too, rather than forcing 0600', () => {
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    chmodSync(isolatedDotClaude(), 0o644)
    writeShared({ gmail: { command: 'npx', args: ['gmail-mcp'] }, extra: { command: 'x' } })
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(Object.keys(servers()).sort()).toEqual(['extra', 'gmail'])
    expect(statSync(isolatedDotClaude()).mode & 0o777).toBe(0o644)
  })

  it('creates a brand new isolated config owner-only, not at the umask default', () => {
    // First provision: no target existed, so the fallback decides. It must be
    // 0600 rather than whatever the umask happens to be on the host.
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    expect(statSync(isolatedDotClaude()).mode & 0o777).toBe(0o600)
  })

  it('leaves no staging file behind (atomic write)', () => {
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')
    writeShared({ gmail: { command: 'npx', args: ['gmail-mcp'] }, extra: { command: 'x' } })
    ensureIsolatedChannelConfigDir(AGENT, 'telegram')

    const stray = readdirSync(join(SANDBOX, 'agents', AGENT, '.claude-config'))
      .filter((f) => f.includes('.tmp-'))
    expect(stray).toEqual([])
  })
})
