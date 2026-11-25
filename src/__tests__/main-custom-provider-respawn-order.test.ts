// HOSTINGERRETEST1125 (Samu's review on #3121): the custom provider env is decided BEFORE the reaps. The reaps (and
// respawn-pane -k) kill the pane's claude; a provider that cannot be served must stop the respawn while the running
// main agent is still there, not after it was killed with nothing started in its place. All three in-process paths:
// the fresh respawn, the --continue resume and the hard restart (Linux: a respawn-pane). Everything that could reach
// the live host is stubbed (tmux through child_process, the reapers, the onboarding re-seed, the settings writer), as
// in main-respawn-hold.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const execCalls: string[][] = []

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFileSync: vi.fn((_cmd: string, args: string[] = []) => { execCalls.push(args); return '' }),
    execSync: vi.fn((cmd: string, opts?: unknown) => /^which [a-z-]+$/.test(cmd) ? real.execSync(cmd, opts as never) : ''),
    spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null })),
    execFile: vi.fn(() => { throw new Error('execFile is not allowed in this test') }),
    exec: vi.fn(() => { throw new Error('exec is not allowed in this test') }),
    spawn: vi.fn(() => { throw new Error('spawn is not allowed in this test') }),
  }
})

vi.mock('../platform.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../platform.js')>()
  return { ...real, makeLazyBinResolver: (name: string) => () => `/nonexistent/fake-${name}` }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const reapChannelOrphans = vi.fn(() => ({ reaped: [], skippedLivePane: [], skippedOtherUid: [], skippedNotPlugin: [], source: { fromBotPid: null, fromEnvScan: [] } }))
const reapDetachedChannelClaudes = vi.fn(() => [])
vi.mock('../web/channel-poller-reap.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/channel-poller-reap.js')>()
  return { ...real, reapChannelOrphans, reapDetachedChannelClaudes }
})

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...real,
    ensureSharedClaudeOnboarded: vi.fn(),
    scheduleIdentitySetup: vi.fn(async () => {}),
    dismissResumeSummaryModalIfPresent: vi.fn(async () => {}),
  }
})

vi.mock('../web/channel-plugin-unlock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/channel-plugin-unlock.js')>()
  return { ...real, schedulePluginUnlockAfterRespawn: vi.fn() }
})

vi.mock('../web/main-extra-plugins-settings.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/main-extra-plugins-settings.js')>()
  return { ...real, writeMainExtraPluginsSettings: vi.fn(() => null) }
})

// The decision the respawn would carry: here, a provider that is configured but cannot be served.
vi.mock('../web/main-custom-provider-env.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/main-custom-provider-env.js')>()
  return {
    ...real,
    mainCustomProviderLaunchEnv: vi.fn(() => { throw new real.MainCustomProviderBroken('the provider "hostinger-router" is configured but cannot be used: vault key missing') }),
  }
})

const { respawnMainSessionFresh, resumeMarveenSession, hardRestartMarveenChannels } = await import('../web/channel-monitor.js')

const realPlatform = process.platform
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'linux' }) }) // the hard restart is a respawn-pane there
afterAll(() => { Object.defineProperty(process, 'platform', { value: realPlatform }) })

beforeEach(() => {
  execCalls.length = 0
  reapChannelOrphans.mockClear()
  reapDetachedChannelClaudes.mockClear()
})

const respawnPaneRan = () => execCalls.some((a) => a.includes('respawn-pane'))

describe('a custom provider that cannot be served stops the respawn before anything is killed', () => {
  it('the fresh respawn: throws, no reap, no respawn-pane', () => {
    expect(() => respawnMainSessionFresh()).toThrow(/cannot be used/)
    expect(reapChannelOrphans).not.toHaveBeenCalled()
    expect(reapDetachedChannelClaudes).not.toHaveBeenCalled()
    expect(respawnPaneRan()).toBe(false)
  })

  it('the --continue resume: false, no reap, no respawn-pane', async () => {
    await expect(resumeMarveenSession()).resolves.toBe(false)
    expect(reapChannelOrphans).not.toHaveBeenCalled()
    expect(reapDetachedChannelClaudes).not.toHaveBeenCalled()
    expect(respawnPaneRan()).toBe(false)
  })

  it('the hard restart (Linux): not ok, no reap, no respawn-pane', () => {
    expect(hardRestartMarveenChannels().ok).toBe(false)
    expect(reapChannelOrphans).not.toHaveBeenCalled()
    expect(reapDetachedChannelClaudes).not.toHaveBeenCalled()
    expect(respawnPaneRan()).toBe(false)
  })
})
