import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ensureMainAgentIsolatedConfigDir: extends the already-proven sub-agent
// isolated-config machinery to the MAIN channels agent, now on ANY platform
// (PLAN.md GAP 1, 2026-07-23 marveen-channels silent outage) -- the previous
// `if (platform !== 'darwin') return null` early return left the main bot on
// Linux depending on the shared, periodically-refreshing
// ~/.claude/.credentials.json. Mirrors main-agent-config-dir.test.ts's mocking
// pattern for the sibling MAIN_AGENT_CONFIG_DIR path.
//
// PROJECT_ROOT/STORE_DIR are baked into module-level constants at import time
// (FLEET_OAUTH_TOKEN_PATH = join(STORE_DIR, '.claude-oauth-token')), so this
// suite uses a SINGLE fixed sandbox for the whole file (created once, mocked
// once) and resets its mutable contents per test, rather than a fresh
// mkdtempSync per test like the homedir()-only isolated-channel-config suite.
const SANDBOX = mkdtempSync(join(tmpdir(), 'mainisocfg-'))
const PROJECT = join(SANDBOX, 'project')
const STORE = join(PROJECT, 'store')
const HOME = join(SANDBOX, 'home')
const TOKEN_PATH = join(STORE, '.claude-oauth-token')

let SETTING = ''

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) =>
      key === 'MAIN_AGENT_ISOLATED_CONFIG' ? SETTING : actual.getEffectiveSettingValue(key),
  }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: PROJECT, STORE_DIR: STORE }
})

const { ensureMainAgentIsolatedConfigDir } = await import('../web/agent-process.js')

beforeEach(() => {
  rmSync(PROJECT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  mkdirSync(join(HOME, '.claude'), { recursive: true })
  writeFileSync(join(HOME, '.claude', 'settings.json'), '{}')
  writeFileSync(TOKEN_PATH, 'sk-ant-oat01-fake\n')
  SETTING = '1'
})
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('ensureMainAgentIsolatedConfigDir', () => {
  it('linux + setting on + fleet token present + ~/.claude present -> isolated dir', () => {
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')
    expect(dir).toBe(join(PROJECT, '.channels-config'))
    expect(existsSync(dir!)).toBe(true)
  })

  it('linux + setting off (default) -> null (zero behavior change for existing installs)', () => {
    SETTING = '0'
    expect(ensureMainAgentIsolatedConfigDir(undefined, 'linux')).toBeNull()
  })

  it('linux + setting on + no fleet token -> null (hasFleetOauthToken gate still applies)', () => {
    rmSync(TOKEN_PATH, { force: true })
    expect(ensureMainAgentIsolatedConfigDir(undefined, 'linux')).toBeNull()
  })

  it('darwin + setting on + fleet token present -> isolated dir (unchanged, no regression)', () => {
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'darwin')
    expect(dir).toBe(join(PROJECT, '.channels-config'))
  })

  it('darwin + setting off (default) -> null (unchanged, no regression)', () => {
    SETTING = '0'
    expect(ensureMainAgentIsolatedConfigDir(undefined, 'darwin')).toBeNull()
  })

  // The settings.json rewrite runs on EVERY main-agent start. It used to be a
  // pure copy of the shared ~/.claude/settings.json, so a key configured for
  // the MAIN AGENT ALONE was dropped at the next restart -- silently, because
  // the agent still starts, it just stops doing whatever that key drove.
  // `statusLine` was lost that way three times (2026-07-28, 07-30, 08-03),
  // each time taking context monitoring blind mid-work with no error anywhere.
  it('keeps isolated-only settings keys the shared file never mentions', () => {
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({
      statusLine: { type: 'command', command: 'ctx.sh' },
      model: 'agent-only-model',
    }, null, 2) + '\n')

    // Second start: the shared file still says nothing about statusLine.
    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect(after.statusLine).toEqual({ type: 'command', command: 'ctx.sh' })
    expect(after.model).toBe('agent-only-model')
  })

  it('lets the shared file win for every key it DOES define', () => {
    writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ model: 'shared-model' }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ model: 'stale-model', statusLine: 'keep-me' }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect(after.model).toBe('shared-model')   // shared wins on conflict
    expect(after.statusLine).toBe('keep-me')   // target-only key still survives
  })
})
