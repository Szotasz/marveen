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

const { ensureMainAgentIsolatedConfigDir, ensureMainAgentIsolatedConfigDirForRotatedToken } = await import('../web/agent-process.js')
const { logger } = await import('../logger.js')

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

  // The Bash egress deny (BASH_EGRESS_DENY) is written into THIS file rather
  // than the shared root, so the operator's own shell stays out of it while the
  // main agent stays in. That only holds if a permissions block survives the
  // rewrite this function performs on every start -- and it survives only
  // because the shared file never mentions `permissions`. Asserted on the real
  // provisioner, not inferred from the merge code, so the guarantee the egress
  // change rests on is executed rather than believed.
  it('keeps a permissions block the shared file never mentions (Bash egress deny target)', () => {
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({
      permissions: { deny: ['Bash(curl *https://*)', 'Bash(wget *)'] },
    }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect((after.permissions as { deny: string[] }).deny).toEqual(['Bash(curl *https://*)', 'Bash(wget *)'])
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

  // `env` is a map of variables: merged at the top level only, any shared
  // `env` dropped the agent's own `env` whole, so an agent-only variable was
  // gone after the next restart. The same rule applies one level deeper.
  it('keeps agent-only env variables when the shared file has its own env (shared wins per variable)', () => {
    writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { OPERATOR_VAR: 'op', SHARED_VAR: 'shared' } }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ env: { SHARED_VAR: 'stale', AGENT_ONLY_VAR: 'agent' } }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect(after.env).toEqual({ OPERATOR_VAR: 'op', SHARED_VAR: 'shared', AGENT_ONLY_VAR: 'agent' })
  })

  // The isolated file is itself a copy of the shared env, so without a record
  // of what came from there, a variable later DELETED from the shared env would
  // look agent-only on the next start and stay forever.
  it('a variable deleted from the shared env disappears on the next start; an agent-only one stays', () => {
    const shared = join(HOME, '.claude', 'settings.json')
    writeFileSync(shared, JSON.stringify({ env: { KEEP: '1', GONE: 'old' } }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    const first = JSON.parse(readFileSync(own, 'utf-8')) as { env: Record<string, string> }
    writeFileSync(own, JSON.stringify({ env: { ...first.env, AGENT_ONLY_VAR: 'agent' } }, null, 2) + '\n')

    writeFileSync(shared, JSON.stringify({ env: { KEEP: '1' } }))
    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect(after.env).toEqual({ KEEP: '1', AGENT_ONLY_VAR: 'agent' })
  })

  it('a variable the shared env takes over later wins over the agent-only value', () => {
    const shared = join(HOME, '.claude', 'settings.json')
    writeFileSync(shared, JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ env: { OPERATOR_VAR: 'op', MINE: 'agent' } }, null, 2) + '\n')

    writeFileSync(shared, JSON.stringify({ env: { OPERATOR_VAR: 'op', MINE: 'operator' } }))
    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect(after.env).toEqual({ OPERATOR_VAR: 'op', MINE: 'operator' })
  })

  it('removing the whole shared env does not resurrect its variables', () => {
    const shared = join(HOME, '.claude', 'settings.json')
    writeFileSync(shared, JSON.stringify({ env: { GONE: 'old' } }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ env: { GONE: 'old', AGENT_ONLY_VAR: 'agent' } }, null, 2) + '\n')

    writeFileSync(shared, '{}')
    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect(after.env).toEqual({ AGENT_ONLY_VAR: 'agent' })
  })

  it('checks own properties only: constructor survives, __proto__ is never copied', () => {
    writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, '{"env": {"constructor": "c", "toString": "t", "__proto__": {"polluted": true}}}\n')

    const spy = vi.spyOn(logger, 'info')
    try {
      ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      const kept = spy.mock.calls.find((c) => c[1] === 'isolated-config: kept target-only settings keys')
      expect((kept?.[0] as { keys: string[] }).keys).toEqual(['env.constructor', 'env.toString'])
    } finally {
      spy.mockRestore()
    }

    const after = JSON.parse(readFileSync(own, 'utf-8')) as { env: Record<string, unknown> }
    expect(Object.prototype.hasOwnProperty.call(after.env, 'constructor')).toBe(true)
    expect(after.env.constructor).toBe('c')
    expect(after.env.toString).toBe('t')
    expect(Object.prototype.hasOwnProperty.call(after.env, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('logs kept names only, never values, and only when the kept set changes', () => {
    const spy = vi.spyOn(logger, 'info')
    try {
      writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
      const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
      const own = join(dir, 'settings.json')
      writeFileSync(own, JSON.stringify({ env: { AGENT_ONLY_VAR: 'secret-value-123' } }, null, 2) + '\n')
      spy.mockClear()

      ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      const kept = () => spy.mock.calls.filter((c) => c[1] === 'isolated-config: kept target-only settings keys')
      expect(kept()).toHaveLength(1)
      expect((kept()[0][0] as { keys: string[] }).keys).toEqual(['env.AGENT_ONLY_VAR'])
      expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-value-123')

      ensureMainAgentIsolatedConfigDir(undefined, 'linux')   // same kept set: no repeated line
      expect(kept()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  // Review on #1942 (start from what the old code leaves behind): the own env
  // is a copy of an older shared env, the operator deletes a variable there and
  // restarts on this version, with no sidecar yet. Keeping the variable would
  // make it look agent-only from then on, and it could be a credential. Without
  // a usable sidecar the old rule applies exactly; the sidecar takes over after.
  it('without a sidecar, a variable deleted from the shared env before the upgrade restart is gone, and stays gone', () => {
    const shared = join(HOME, '.claude', 'settings.json')
    writeFileSync(shared, JSON.stringify({ env: { KEEP: '1' } }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    rmSync(join(dir, '.shared-env-keys.json'))
    writeFileSync(own, JSON.stringify({ env: { KEEP: '1', ANTHROPIC_API_KEY: 'sk-old' } }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')
    expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toEqual({ KEEP: '1' })
    expect(existsSync(join(dir, '.shared-env-keys.json'))).toBe(true)

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')
    expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toEqual({ KEEP: '1' })
  })

  it('without a sidecar, the warning lists every dropped own name, __proto__ included, and nothing is copied', () => {
    const warn = vi.spyOn(logger, 'warn')
    try {
      writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
      const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
      const own = join(dir, 'settings.json')
      rmSync(join(dir, '.shared-env-keys.json'))
      writeFileSync(own, '{"env": {"OPERATOR_VAR": "op", "__proto__": {"polluted": true}, "MINE": "a"}}\n')

      ensureMainAgentIsolatedConfigDir(undefined, 'linux')

      const w = warn.mock.calls.find((c) => String(c[1]).startsWith('isolated-config: no usable shared-env sidecar'))
      expect((w?.[0] as { keys: string[] }).keys).toEqual(['__proto__', 'MINE'])
      expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toEqual({ OPERATOR_VAR: 'op' })
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('without a sidecar and with no shared env, the own env is kept as it was', () => {
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    rmSync(join(dir, '.shared-env-keys.json'))
    writeFileSync(own, JSON.stringify({ env: { MINE: 'agent' } }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toEqual({ MINE: 'agent' })
  })

  it('warns with the dropped env names, never values, when the sidecar is missing or unreadable', () => {
    const warn = vi.spyOn(logger, 'warn')
    try {
      writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
      const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
      const own = join(dir, 'settings.json')
      const side = join(dir, '.shared-env-keys.json')
      const msg = 'isolated-config: no usable shared-env sidecar, the old rule applies this time: own env names not in the shared env are dropped; the sidecar takes over from the next start'
      const calls = () => warn.mock.calls.filter((c) => c[1] === msg).map((c) => c[0] as { sidecar: string; keys: string[] })
      const withMine = () => writeFileSync(own, JSON.stringify({ env: { OPERATOR_VAR: 'op', MINE: 'secret-value-456' } }, null, 2) + '\n')

      withMine()
      ensureMainAgentIsolatedConfigDir(undefined, 'linux')       // sidecar present: no warning, MINE kept
      expect(calls()).toHaveLength(0)
      expect((JSON.parse(readFileSync(own, 'utf-8')) as { env: Record<string, string> }).env.MINE).toBe('secret-value-456')

      rmSync(side)
      ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      expect(calls()).toEqual([expect.objectContaining({ sidecar: 'missing', keys: ['MINE'] })])
      expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toEqual({ OPERATOR_VAR: 'op' })

      withMine()
      writeFileSync(side, '{not json')
      ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      expect(calls()[1]).toEqual(expect.objectContaining({ sidecar: 'unreadable', keys: ['MINE'] }))

      withMine()
      writeFileSync(side, '["valid JSON, not an object"]')
      ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      expect(calls()[2]).toEqual(expect.objectContaining({ sidecar: 'unreadable', keys: ['MINE'] }))

      withMine()
      writeFileSync(side, '{"keptKeys": []}')                    // an object, but no sharedEnvKeys list: no history
      ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      expect(calls()[3]).toEqual(expect.objectContaining({ sidecar: 'unreadable', keys: ['MINE'] }))
      expect(calls()).toHaveLength(4)
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value-456')
    } finally {
      warn.mockRestore()
    }
  })

  it('a sidecar that cannot be written warns, and the settings and the rest of the dir are still provisioned', () => {
    const warn = vi.spyOn(logger, 'warn')
    try {
      writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
      const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
      const own = join(dir, 'settings.json')
      const side = join(dir, '.shared-env-keys.json')
      rmSync(side)
      mkdirSync(join(side, 'blocker'), { recursive: true })   // a non-empty directory: the atomic rename fails
      writeFileSync(own, JSON.stringify({ env: { MINE: 'agent' } }, null, 2) + '\n')
      rmSync(join(dir, 'plugins'), { recursive: true, force: true })

      expect(ensureMainAgentIsolatedConfigDir(undefined, 'linux')).toBe(dir)

      // no readable sidecar (a directory stands there): the old rule, the shared env replaces the own one whole
      const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
      expect(after.env).toEqual({ OPERATOR_VAR: 'op' })
      expect(existsSync(join(dir, 'plugins'))).toBe(true)
      expect(warn.mock.calls.some((c) => String(c[1]).startsWith('isolated-config: could not write the shared-env sidecar'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  // Review on #1942: an agent with no own variables keeps the file it had.
  // A failed atomic write leaves the old sidecar behind; its stale names would
  // pass for a valid history. It is removed, so the next start is "missing".
  it('a failed sidecar write removes the stale sidecar, and the next start applies the old rule', () => {
    const warn = vi.spyOn(logger, 'warn')
    try {
      const shared = join(HOME, '.claude', 'settings.json')
      writeFileSync(shared, JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
      const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
      const own = join(dir, 'settings.json')
      const side = join(dir, '.shared-env-keys.json')
      expect(existsSync(side)).toBe(true)
      const tmpBlocker = `${side}.tmp-${process.pid}`
      mkdirSync(join(tmpBlocker, 'blocker'), { recursive: true })   // the temp file cannot be created
      try {
        ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      } finally {
        rmSync(tmpBlocker, { recursive: true, force: true })
      }
      expect(existsSync(side)).toBe(false)
      expect(warn.mock.calls.some((c) => String(c[1]).startsWith('isolated-config: could not write the shared-env sidecar'))).toBe(true)

      writeFileSync(own, JSON.stringify({ env: { OPERATOR_VAR: 'op', LATER_GONE: 'x' } }, null, 2) + '\n')
      ensureMainAgentIsolatedConfigDir(undefined, 'linux')
      expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toEqual({ OPERATOR_VAR: 'op' })
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps an empty own env ({}) when there is no shared env', () => {
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ env: {} }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    expect(JSON.parse(readFileSync(own, 'utf-8'))).toHaveProperty('env', {})
  })

  it('a shared env that is not a map wins whole over an own map, as under the old rule', () => {
    writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: 'not-a-map' }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ env: { MINE: 'agent' } }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toBe('not-a-map')
  })

  it('keeps a non-map own env as is when there is no shared env', () => {
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ env: ['not', 'a', 'map'] }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    expect((JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>).env).toEqual(['not', 'a', 'map'])
  })

  it('keeps the shared env as is when the own env is not a plain object', () => {
    writeFileSync(join(HOME, '.claude', 'settings.json'), JSON.stringify({ env: { OPERATOR_VAR: 'op' } }))
    const dir = ensureMainAgentIsolatedConfigDir(undefined, 'linux')!
    const own = join(dir, 'settings.json')
    writeFileSync(own, JSON.stringify({ env: ['not', 'a', 'map'] }, null, 2) + '\n')

    ensureMainAgentIsolatedConfigDir(undefined, 'linux')

    const after = JSON.parse(readFileSync(own, 'utf-8')) as Record<string, unknown>
    expect(after.env).toEqual({ OPERATOR_VAR: 'op' })
  })
})

// Token-mode rotation (2026-09-12): the SAME generic dir, but for a plan that
// supplies its own CLAUDE_CODE_OAUTH_TOKEN instead of the fleet's. The one
// behavioral difference from ensureMainAgentIsolatedConfigDir: no fleet-token
// gate, since a token-mode plan makes the flotta token irrelevant.
describe('ensureMainAgentIsolatedConfigDirForRotatedToken', () => {
  it('provisions the SAME dir as ensureMainAgentIsolatedConfigDir when a fleet token exists', () => {
    expect(ensureMainAgentIsolatedConfigDirForRotatedToken()).toBe(join(PROJECT, '.channels-config'))
  })

  it('provisions it even with NO fleet token -- the plan brings its own', () => {
    rmSync(TOKEN_PATH, { force: true })
    const dir = ensureMainAgentIsolatedConfigDirForRotatedToken()
    expect(dir).toBe(join(PROJECT, '.channels-config'))
    expect(existsSync(dir!)).toBe(true)
  })

  it('still returns null when MAIN_AGENT_ISOLATED_CONFIG is off', () => {
    SETTING = '0'
    expect(ensureMainAgentIsolatedConfigDirForRotatedToken()).toBeNull()
  })
})
