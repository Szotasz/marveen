import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// SHAREDENVCOPY: the isolated provisioning copies the shared
// ~/.claude/settings.json `env` into every isolated settings.json, and that
// copy stays. What it must not do is move an agent onto an API key or another
// endpoint SILENTLY: an auth-path name in the shared env is warned about on
// every start (log) and shown on the agent card (summary field), names only.
let SANDBOX = ''
let CONFIGURED_DIR: string | null = null
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: (name: string) => join(SANDBOX, 'agents', name),
    readAgentClaudeConfigDir: () => CONFIGURED_DIR,
  }
})

const { ensureIsolatedChannelConfigDir, authKeysInEnv, sharedEnvAuthKeysCopiedTo, SHARED_ENV_AUTH_KEYS } = await import('../web/agent-process.js')
const { logger } = await import('../logger.js')

const MSG = 'isolated-config: the shared settings env carries auth keys into this agent; it may run on that key or endpoint instead of its own token'
const SECRET = 'fixture-value-never-logged-789'

function writeShared(settings: unknown): void {
  writeFileSync(join(SANDBOX, 'home', '.claude', 'settings.json'), JSON.stringify(settings))
}

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'sharedenvauth-'))
  mkdirSync(join(SANDBOX, 'home', '.claude'), { recursive: true })
  mkdirSync(join(SANDBOX, 'agents', 'ag'), { recursive: true })
  CONFIGURED_DIR = null
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('authKeysInEnv', () => {
  it('names exactly the four auth-path variables, in a fixed order', () => {
    expect(SHARED_ENV_AUTH_KEYS).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'])
    expect(authKeysInEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 't', OTHER: 'x', ANTHROPIC_BASE_URL: 'u', ANTHROPIC_AUTH_TOKEN: 'a', ANTHROPIC_API_KEY: SECRET,
    })).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'])
  })

  it('ignores every other name, near misses included', () => {
    expect(authKeysInEnv({ CLAUDE_CODE_PLUGIN_DIRS: 'p', ANTHROPIC_MODEL: 'm', anthropic_api_key: 'x', OPENAI_API_KEY: 'k' })).toEqual([])
  })

  it('returns nothing for a missing or non-map env, and never sees prototype names', () => {
    expect(authKeysInEnv(undefined)).toEqual([])
    expect(authKeysInEnv('ANTHROPIC_API_KEY')).toEqual([])
    expect(authKeysInEnv(['ANTHROPIC_API_KEY'])).toEqual([])
    const proto = Object.create({ ANTHROPIC_API_KEY: 'inherited' }) as Record<string, unknown>
    expect(authKeysInEnv(proto)).toEqual([])
  })
})

describe('start-time warning in the isolated provisioning', () => {
  const warnCalls = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => c[1] === MSG).map((c) => c[0] as { name: string; keys: string[] })

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'])(
    'warns, naming the agent and the key, when the shared env carries %s',
    (key) => {
      writeShared({ env: { [key]: SECRET, OPERATOR_VAR: 'op' } })
      const warn = vi.spyOn(logger, 'warn')
      expect(ensureIsolatedChannelConfigDir('ag', 'telegram')).not.toBeNull()
      expect(warnCalls(warn)).toEqual([expect.objectContaining({ name: 'ag', keys: [key] })])
    },
  )

  it('warns on every start, not once', () => {
    writeShared({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } })
    const warn = vi.spyOn(logger, 'warn')
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    expect(warnCalls(warn)).toHaveLength(2)
  })

  it('stays silent for any other shared env name, and for no shared env', () => {
    const warn = vi.spyOn(logger, 'warn')
    writeShared({ env: { CLAUDE_CODE_PLUGIN_DIRS: 'p', ANTHROPIC_MODEL: 'm' } })
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    writeShared({ permissions: { deny: [] } })
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    expect(warnCalls(warn)).toHaveLength(0)
  })

  it('never puts a value in the log', () => {
    writeShared({ env: { ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET } })
    const warn = vi.spyOn(logger, 'warn')
    const info = vi.spyOn(logger, 'info')
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    expect(warnCalls(warn)[0].keys).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'])
    expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain(SECRET)
  })
})

describe('sharedEnvAuthKeysCopiedTo (the dashboard field)', () => {
  it('names the auth keys the shared env copied into the agent, values never', () => {
    writeShared({ env: { ANTHROPIC_API_KEY: SECRET, OTHER: 'x' } })
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    const keys = sharedEnvAuthKeysCopiedTo('ag')
    expect(keys).toEqual(['ANTHROPIC_API_KEY'])
    expect(JSON.stringify(keys)).not.toContain(SECRET)
  })

  it('clears once the shared file no longer carries the key, even before a restart', () => {
    writeShared({ env: { ANTHROPIC_API_KEY: SECRET } })
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    writeShared({ env: { OTHER: 'x' } })
    expect(sharedEnvAuthKeysCopiedTo('ag')).toEqual([])
  })

  it('is empty for an agent that was never provisioned, or that runs on a configured config dir', () => {
    writeShared({ env: { ANTHROPIC_API_KEY: SECRET } })
    expect(sharedEnvAuthKeysCopiedTo('ag')).toEqual([])
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    CONFIGURED_DIR = join(SANDBOX, 'own-dir')
    expect(sharedEnvAuthKeysCopiedTo('ag')).toEqual([])
  })

  it('does not report a key the shared file gained after this agent last started', () => {
    writeShared({ env: { OTHER: 'x' } })
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    writeShared({ env: { OTHER: 'x', ANTHROPIC_API_KEY: SECRET } })
    expect(sharedEnvAuthKeysCopiedTo('ag')).toEqual([])
    ensureIsolatedChannelConfigDir('ag', 'telegram')
    expect(sharedEnvAuthKeysCopiedTo('ag')).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('does not report an auth key the agent holds on its own', () => {
    writeShared({ env: { OTHER: 'x' } })
    const dir = ensureIsolatedChannelConfigDir('ag', 'telegram')!
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'own' } }))
    expect(sharedEnvAuthKeysCopiedTo('ag')).toEqual([])
  })
})
