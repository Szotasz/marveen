// HOSTINGERRETEST1125: the in-process main respawns carry the main agent's custom provider (the Hostinger AI Router),
// as channels.sh's cold launch does. Before: a dashboard restart on Linux (a respawn-pane) and the restart after the
// wizard's router step started the main agent without ANTHROPIC_BASE_URL / the key, on a Claude login the install
// does not have.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMainSessionRespawnCmd, PANE_AUTH_POST_PATH } from '../web/channel-monitor.js'
import { mainCustomProviderLaunchEnv, MainCustomProviderBroken, type CustomProviderEnvDeps } from '../web/main-custom-provider-env.js'

const ENV = "unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL='https://router.hostinger.com' && export ANTHROPIC_API_KEY=\"$(cat '/k')\" && unset ANTHROPIC_AUTH_TOKEN && export ANTHROPIC_MODEL='claude-sonnet-5-5'"
const base = {
  claudePath: '/x/claude', pluginId: 'telegram@claude-plugins-official', channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/s' },
  model: 'claude-opus-5-5', continueSession: false, config: { isolatedConfigDir: null, fleetToken: false }, disallowedTools: '',
}

describe('buildMainSessionRespawnCmd: the custom provider env', () => {
  it('goes after the auth post-file and before claude, and the --model flag is dropped', () => {
    const cmd = buildMainSessionRespawnCmd({ ...base, customProviderEnv: ENV } as never)
    const env = cmd.indexOf(ENV)
    expect(env).toBeGreaterThan(cmd.indexOf(`. '${PANE_AUTH_POST_PATH}'`))
    expect(env).toBeLessThan(cmd.indexOf('/x/claude'))
    expect(cmd).not.toContain('--model')
  })

  it('without a provider the command is as before: --model, no provider env', () => {
    for (const customProviderEnv of [undefined, '']) {
      const cmd = buildMainSessionRespawnCmd({ ...base, customProviderEnv } as never)
      expect(cmd).toContain("--model 'claude-opus-5-5'")
      expect(cmd).not.toContain('ANTHROPIC_BASE_URL')
    }
  })
})

describe('mainCustomProviderLaunchEnv', () => {
  const deps = (over: Partial<CustomProviderEnvDeps> & { calls?: string[][] } = {}): CustomProviderEnvDeps => ({
    provider: () => 'hostinger-router',
    runHelper: (args) => { over.calls?.push(args); return ENV + ' && ' },
    dirExists: () => true,
    ...over,
  })

  it('no provider: empty, and the helper is not run', () => {
    const calls: string[][] = []
    expect(mainCustomProviderLaunchEnv('/cfg', deps({ provider: () => null, calls }))).toBe('')
    expect(calls).toEqual([])
  })

  it("a provider: the helper's prefix without its trailing &&", () => {
    expect(mainCustomProviderLaunchEnv(null, deps())).toBe(ENV)
  })

  it('the config dir is passed only when it exists (as channels.sh)', () => {
    const calls: string[][] = []
    mainCustomProviderLaunchEnv('/cfg', deps({ calls }))
    mainCustomProviderLaunchEnv('/gone', deps({ calls, dirExists: () => false }))
    mainCustomProviderLaunchEnv(null, deps({ calls }))
    expect(calls).toEqual([['/cfg'], [], []])
  })

  it('a configured provider the helper cannot serve stops the respawn (no silent wrong-backend launch)', () => {
    const failing = deps({ runHelper: () => { throw Object.assign(new Error('exit 1'), { stderr: 'main-agent-custom-provider: vault key "x" missing\n' }) } })
    expect(() => mainCustomProviderLaunchEnv(null, failing)).toThrow(MainCustomProviderBroken)
    expect(() => mainCustomProviderLaunchEnv(null, failing)).toThrow(/vault key "x" missing/)
    expect(() => mainCustomProviderLaunchEnv(null, deps({ runHelper: () => '' }))).toThrow(MainCustomProviderBroken)
  })
})

it('all three in-process main respawns pass the provider env from the same config decision', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'web', 'channel-monitor.ts'), 'utf-8')
  expect(src.match(/const respawnConfig = mainRespawnConfigWithAuth\(\)/g)?.length).toBe(3)
  expect(src.match(/const customProviderEnv = mainCustomProviderLaunchEnv\(respawnConfig\.isolatedConfigDir\)/g)?.length).toBe(3)
  expect(src.match(/^\s*customProviderEnv,$/gm)?.length).toBe(3)
  expect(src.match(/buildMainSessionRespawnCmd\(\{/g)?.length).toBe(3)
})
