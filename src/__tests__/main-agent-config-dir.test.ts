import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// MAIN_AGENT_CONFIG_DIR: an EXPLICIT CLAUDE_CONFIG_DIR for the main channels
// agent, for the operator whose bot has its own Claude login (separate from the
// fleet's). Distinct from MAIN_AGENT_ISOLATED_CONFIG, which authenticates from
// the fleet setup-token and therefore cannot keep the two identities apart.
let SANDBOX = ''
let SETTING = ''

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => join(SANDBOX, 'home') }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_CONFIG_DIR' ? SETTING : actual.getEffectiveSettingValue(key),
  }
})

const { resolveMainAgentConfigDir } = await import('../web/agent-process.js')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'maincfg-'))
  mkdirSync(join(SANDBOX, 'home', '.claude-bot'), { recursive: true })
  SETTING = ''
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('resolveMainAgentConfigDir', () => {
  it('returns null when the setting is unset (shared ~/.claude, unchanged default)', () => {
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('resolves an absolute path that exists', () => {
    SETTING = join(SANDBOX, 'home', '.claude-bot')
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('expands a leading ~ against the home dir', () => {
    SETTING = '~/.claude-bot'
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })

  it('returns null (not the unresolved path) when the dir does not exist', () => {
    // Falling back to the shared root is the safe failure: launching with a
    // non-existent CLAUDE_CONFIG_DIR would start the bot logged-out.
    SETTING = join(SANDBOX, 'home', '.claude-nope')
    expect(resolveMainAgentConfigDir()).toBeNull()
  })

  it('trims surrounding whitespace from a hand-edited .env value', () => {
    SETTING = `  ${join(SANDBOX, 'home', '.claude-bot')}  `
    expect(resolveMainAgentConfigDir()).toBe(join(SANDBOX, 'home', '.claude-bot'))
  })
})

describe('launcher wiring', () => {
  const HELPER = readFileSync(join(__dirname, '../../scripts/main-agent-isolated-config.mjs'), 'utf-8')
  const CHANNELS = readFileSync(join(__dirname, '../../scripts/channels.sh'), 'utf-8')

  it('the helper prefers the explicit dir over the isolated one', () => {
    expect(HELPER).toMatch(/const explicit = resolveMainAgentConfigDir\(\)[\s\S]*if \(explicit\)/)
  })

  it('the helper tags each path with its mode so the caller knows how to authenticate', () => {
    expect(HELPER).toMatch(/explicit\\t/)
    expect(HELPER).toMatch(/isolated\\t/)
  })

  it('channels.sh never injects the fleet token for an explicit dir', () => {
    // The explicit dir carries its OWN .credentials.json -- exporting the fleet
    // token there would silently authenticate the bot as the fleet.
    const explicitBranch = CHANNELS.match(/if \[ "\$_cfg_mode" = "explicit" \]; then\n([\s\S]*?)\n\s*else/)
    expect(explicitBranch).not.toBeNull()
    expect(explicitBranch?.[1]).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/)
    expect(explicitBranch?.[1]).toMatch(/CLAUDE_CONFIG_DIR/)
  })
})
