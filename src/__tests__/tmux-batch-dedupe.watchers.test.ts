import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../logger.js'
import { tmuxBatchListSessionsFailed } from '../web/agent-process.js'
import { controlDir } from '../web/ssh-tmux.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import { startStuckInputWatcher } from '../web/stuck-input-watcher.js'
import { startReauthHealer } from '../web/reauth-healer.js'
import { startChannelIntakeMonitor, resetIntakeObservations } from '../web/channel-intake-monitor.js'

const h = vi.hoisted(() => ({
  agents: ['dedupe-b', 'dedupe-c', 'dedupe-a'],
  sessions: 'agent-dedupe-b\nagent-dedupe-a\n',
  listError: null as unknown,
  failNonLocalLists: false,
  remoteHost: {} as Record<string, string | null>,
  runAsUser: {} as Record<string, string | null>,
  spawns: [] as Array<{ file: string; args: string[] }>,
  hostReads: [] as string[],
}))

// Keep agent-process real: only its child-process boundary is faked.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = (file: string, args: readonly string[] = []) => {
    h.spawns.push({ file, args: [...args] })
    const nonLocal = file === 'ssh' || file === 'sudo'
    const isList = file === 'ssh' ? args[args.length - 1]?.includes("'list-sessions'") : args.includes('list-sessions')
    if (isList) {
      if (h.listError !== null) throw h.listError
      if (h.failNonLocalLists && nonLocal) throw new Error('non-local list-sessions failed')
      return h.sessions
    }
    return ''
  }
  // A microtask completes async pane reads without touching live tmux.
  const execFile = (file: string, args: string[], opts: unknown, cb: Function) => {
    const result = execFileSync(file, args)
    Promise.resolve().then(() => cb(null, result, ''))
    return { stdin: { end() {} } }
  }
  return { ...actual, execFileSync, execFile }
})
vi.mock('../config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config.js')>(), RESPAWN_ENABLED: true,
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../web/agent-config.js')>(),
  listAgentNames: () => [...h.agents],
  readAgentRemoteHost: (name: string) => { h.hostReads.push(name); return h.remoteHost[name] ?? null },
  readAgentRunAsUser: (name: string) => h.runAsUser[name] ?? null,
}))
vi.mock('../web/channel-mcp-reconnect.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../web/channel-mcp-reconnect.js')>(),
  resolveAgentSession: (name: string) => `agent-${name}`,
}))
vi.mock('../web/fleet-freeze.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../web/fleet-freeze.js')>(),
  whileNotFrozen: (_name: string, fn: Function) => fn,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const isChannelEnv = (path: unknown) => String(path).endsWith('/channels/telegram/.env')
  return {
    ...actual,
    mkdirSync: (path: Parameters<typeof actual.mkdirSync>[0], ...args: any[]) =>
      String(path) === controlDir() ? undefined : (actual.mkdirSync as Function)(path, ...args),
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => isChannelEnv(path) || actual.existsSync(path),
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...args: any[]) =>
      isChannelEnv(path) ? `TELEGRAM_BOT_TOKEN=${String(path).includes('dedupe-') ? String(path).match(/dedupe-[abc]/)![0] : 'main'}`
        : (actual.readFileSync as Function)(path, ...args),
  }
})
vi.mock('../web/inbound-probe.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../web/inbound-probe.js')>(),
  readLastIngestionTimestampAcross: () => null,
}))

const listArgs = ['list-sessions', '-F', '#{session_name}']
const listSpawns = () => h.spawns.filter(s => s.args[0] === 'list-sessions')
const panes = () => h.spawns.filter(s => s.args[0] === 'capture-pane')
  .map(s => s.args[s.args.indexOf('-t') + 1].replace(/^=/, '').replace(/:$/, ''))
const runningOrder = ['agent-dedupe-b', 'agent-dedupe-a']

beforeEach(() => {
  vi.useFakeTimers()
  h.spawns.length = 0
  h.hostReads = []
  h.agents = ['dedupe-b', 'dedupe-c', 'dedupe-a']
  h.sessions = 'agent-dedupe-b\nagent-dedupe-a\n'
  h.listError = null
  h.failNonLocalLists = false
  h.remoteHost = {}
  h.runAsUser = {}
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200, json: async () => ({ ok: true, result: { pending_update_count: 2 } }),
  })))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// Identify the private maps by their actual delete calls, seed stale state,
// then prove the next pass removes it. No production state exports are needed.
function deletedMaps(spy: { mock: { calls: unknown[][]; contexts: unknown[] } }, key: string): Map<string, unknown>[] {
  return spy.mock.calls.flatMap((args, i) => args[0] === key ? [spy.mock.contexts[i] as Map<string, unknown>] : [])
}
function expectOneListSpawn() {
  expect(listSpawns().map(s => s.args)).toEqual([listArgs])
  expect(listSpawns()[0].file).toMatch(/(?:^|\/)tmux$/)
}

function listTimeoutError() {
  // Measured tmux 3.6 timeout shape: the client catches SIGTERM and exits 0.
  return Object.assign(new Error('spawnSync tmux ETIMEDOUT'), {
    code: 'ETIMEDOUT', status: 0, signal: null, stdout: '',
  })
}

function expectOnlyListAndMainCaptures() {
  expectOneListSpawn()
  for (const spawn of h.spawns) {
    if (spawn.args[0] === 'list-sessions') continue
    expect(spawn.file).toMatch(/(?:^|\/)tmux$/)
    expect(spawn.args[0]).toBe('capture-pane')
    expect(spawn.args[spawn.args.indexOf('-t') + 1].replace(/^=/, '').replace(/:$/, ''))
      .toBe(MAIN_CHANNELS_SESSION)
  }
}

describe('watcher run-state prepasses', () => {
  it('stuck-input: one list-sessions, ordered panes, stopped watchState deleted', async () => {
    const deletes = vi.spyOn(Map.prototype, 'delete')
    startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(15_000)
    const maps = deletedMaps(deletes, 'agent-dedupe-c')
    expect(maps).toHaveLength(1)
    maps[0].set('agent-dedupe-c', { parkedSig: 'stale' })
    h.spawns.length = 0
    // The initial timeout is a separate pass at 20s.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(panes()).toEqual([MAIN_CHANNELS_SESSION, MAIN_CHANNELS_SESSION,
      runningOrder[0], runningOrder[0], runningOrder[1], runningOrder[1]])
    expect(maps[0].has('agent-dedupe-c')).toBe(false)
    expectOneListSpawn()
  })

  it('reauth: one list-sessions, ordered panes, both stopped maps deleted', async () => {
    const deletes = vi.spyOn(Map.prototype, 'delete')
    expect(startReauthHealer()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(90_000)
    const maps = [...new Set(deletedMaps(deletes, 'agent-dedupe-c'))]
    expect(maps).toHaveLength(2)
    for (const map of maps) map.set('agent-dedupe-c', { consecutiveDead: 2 })
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(90_000)
    expect(panes()).toEqual([MAIN_CHANNELS_SESSION, ...runningOrder])
    for (const map of maps) expect(map.has('agent-dedupe-c')).toBe(false)
    expectOneListSpawn()
  })

  it.each([
    ['remote', 'ssh'],
    ['run-as', 'sudo'],
  ] as const)('reauth: a %s list-sessions failure does not skip local agents', async (target, file) => {
    h.agents.push('dedupe-nonlocal')
    if (target === 'remote') h.remoteHost['dedupe-nonlocal'] = 'offline-laptop'
    else h.runAsUser['dedupe-nonlocal'] = 'other-user'
    h.failNonLocalLists = true
    const warn = vi.spyOn(logger, 'warn')

    expect(startReauthHealer()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(90_000)

    expect(panes()).toEqual([MAIN_CHANNELS_SESSION, ...runningOrder])
    expect(h.spawns.filter(s => s.file === file)).toHaveLength(1)
    expect(h.spawns.find(s => s.file === file)!.args.join(' ')).toContain('list-sessions')
    expectOneListSpawn()
    expect(warn).not.toHaveBeenCalled()
    expect(tmuxBatchListSessionsFailed()).toBe(false)
  })

  it('intake: excludes main from run-state reads, preserves probe order and deletes stopped history', async () => {
    h.agents = [MAIN_AGENT_ID, ...h.agents]
    const deletes = vi.spyOn(Map.prototype, 'delete')
    startChannelIntakeMonitor('/unused-project')
    await vi.advanceTimersByTimeAsync(100_000)
    const maps = deletedMaps(deletes, 'dedupe-c')
    expect(maps).toHaveLength(1)
    maps[0].set('dedupe-c', { at: 1, pendingUpdates: 99 })
    h.spawns.length = 0
    vi.mocked(fetch).mockClear()
    h.hostReads = []
    await vi.advanceTimersByTimeAsync(200_000)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'https://api.telegram.org/botmain/getWebhookInfo',
      'https://api.telegram.org/botdedupe-b/getWebhookInfo',
      'https://api.telegram.org/botdedupe-a/getWebhookInfo',
    ])
    expect(panes()).toEqual([])
    expect(h.hostReads).toEqual(['dedupe-b', 'dedupe-c', 'dedupe-a'])
    expect(maps[0].has('dedupe-c')).toBe(false)
    expectOneListSpawn()
  })

  it('stuck-input: a timed-out list-sessions keeps every spell for that pass and starts, messages, alerts nothing', async () => {
    const deletes = vi.spyOn(Map.prototype, 'delete')
    startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(15_000)
    const maps = deletedMaps(deletes, 'agent-dedupe-c')
    expect(maps).toHaveLength(1)
    const spell = { parkedSig: 'stale', firstSeenAt: 1, lastRecoverAt: 2, attempts: 3 }
    for (const name of h.agents) maps[0].set(`agent-${name}`, spell)

    h.listError = listTimeoutError()
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(5_000)
    expectOnlyListAndMainCaptures()
    // One failed listing is not "every session gone": nothing is decided this pass.
    for (const name of h.agents) expect(maps[0].get(`agent-${name}`)).toEqual(spell)

    h.listError = null
    h.spawns.length = 0
    // Repeat the same advance to reach the next interval after the initial timeout.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(panes()).toEqual([MAIN_CHANNELS_SESSION, MAIN_CHANNELS_SESSION,
      runningOrder[0], runningOrder[0], runningOrder[1], runningOrder[1]])
    expectOneListSpawn()
    // The next successful listing decides: the stopped agent's spell goes now.
    expect(maps[0].has('agent-dedupe-c')).toBe(false)
  })

  it('reauth: a timed-out list-sessions skips one pass and starts, messages, alerts nothing', async () => {
    vi.setSystemTime(new Date('2026-11-16T01:00:00Z'))
    const deletes = vi.spyOn(Map.prototype, 'delete')
    expect(startReauthHealer()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(90_000)
    const maps = [...new Set(deletedMaps(deletes, 'agent-dedupe-c'))]
    expect(maps).toHaveLength(2)
    for (const map of maps) {
      for (const session of runningOrder) map.set(session, { consecutiveDead: 2 })
    }

    h.listError = listTimeoutError()
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(90_000)
    expectOnlyListAndMainCaptures()
    for (const map of maps) {
      for (const session of runningOrder) expect(map.has(session)).toBe(true)
    }

    h.listError = null
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(90_000)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(panes()).toEqual([MAIN_CHANNELS_SESSION, ...runningOrder])
    expectOneListSpawn()
  })

  it('reauth: a failed batch preserves cooldowns until a healthy read confirms absent sessions', async () => {
    // Keep the independent morning summary from consuming the seeded quiet state.
    vi.setSystemTime(new Date('2026-11-16T01:00:00Z'))
    const deletes = vi.spyOn(Map.prototype, 'delete')
    expect(startReauthHealer()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(90_000)
    const maps = [...new Set(deletedMaps(deletes, 'agent-dedupe-c'))]
    expect(maps).toHaveLength(2)
    const state = { consecutiveDead: 3, lastActionAtMs: Date.now() }
    for (const map of maps) {
      for (const name of h.agents) map.set(`agent-${name}`, state)
    }

    h.listError = listTimeoutError()
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(90_000)
    expectOnlyListAndMainCaptures()
    for (const map of maps) {
      for (const name of h.agents) expect(map.get(`agent-${name}`)).toEqual(state)
    }

    h.listError = null
    h.sessions = ''
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(180_000)
    expectOnlyListAndMainCaptures()
    for (const map of maps) {
      for (const name of h.agents) expect(map.has(`agent-${name}`)).toBe(false)
    }
  })

  it('intake: a timed-out list-sessions keeps every observation for that pass and starts, messages, alerts nothing', async () => {
    h.agents = [MAIN_AGENT_ID, ...h.agents]
    const deletes = vi.spyOn(Map.prototype, 'delete')
    startChannelIntakeMonitor('/unused-project')
    await vi.advanceTimersByTimeAsync(100_000)
    const maps = deletedMaps(deletes, 'dedupe-c')
    expect(maps).toHaveLength(1)
    const observation = { at: 1, pendingUpdates: 99 }
    for (const name of ['dedupe-b', 'dedupe-c', 'dedupe-a']) maps[0].set(name, observation)

    h.listError = listTimeoutError()
    h.spawns.length = 0
    vi.mocked(fetch).mockClear()
    await vi.advanceTimersByTimeAsync(200_000)
    expectOnlyListAndMainCaptures()
    // One failed listing is not "every agent stopped": nothing is decided this pass.
    for (const name of ['dedupe-b', 'dedupe-c', 'dedupe-a']) expect(maps[0].get(name)).toEqual(observation)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'https://api.telegram.org/botmain/getWebhookInfo',
    ])

    h.listError = null
    h.spawns.length = 0
    vi.mocked(fetch).mockClear()
    h.hostReads = []
    await vi.advanceTimersByTimeAsync(200_000)
    await vi.advanceTimersByTimeAsync(200_000)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'https://api.telegram.org/botmain/getWebhookInfo',
      'https://api.telegram.org/botdedupe-b/getWebhookInfo',
      'https://api.telegram.org/botdedupe-a/getWebhookInfo',
    ])
    expect(panes()).toEqual([])
    expect(h.hostReads).toEqual(['dedupe-b', 'dedupe-c', 'dedupe-a'])
    expectOneListSpawn()
    // The next successful listing decides: the stopped agent's observation goes now.
    expect(maps[0].has('dedupe-c')).toBe(false)
  })

  it('intake: after one failed listing the deaf alerts come at the same passes as without it', async () => {
    h.agents = [MAIN_AGENT_ID, ...h.agents]
    // Every bot holds 2 unfetched updates, so each running agent reads deaf from its second reading on.
    async function deadPerPass(failAtPass: number | null): Promise<string[][]> {
      vi.clearAllTimers()
      resetIntakeObservations()
      const warn = vi.spyOn(logger, 'warn')
      startChannelIntakeMonitor('/unused-project')
      const passes: string[][] = []
      for (const [i, step] of [100_000, 200_000, 300_000, 300_000, 300_000].entries()) {
        h.listError = i === failAtPass ? listTimeoutError() : null
        warn.mockClear()
        await vi.advanceTimersByTimeAsync(step)
        passes.push(warn.mock.calls
          .filter(c => c[1] === 'channel-intake-monitor: channel intake is dead')
          .map(c => String((c[0] as { agent: string }).agent)))
      }
      warn.mockRestore()
      return passes
    }
    const clean = await deadPerPass(null)
    const failed = await deadPerPass(2)
    expect(clean).toEqual([[], [MAIN_AGENT_ID, 'dedupe-b', 'dedupe-a'], [MAIN_AGENT_ID, 'dedupe-b', 'dedupe-a'],
      [MAIN_AGENT_ID, 'dedupe-b', 'dedupe-a'], [MAIN_AGENT_ID, 'dedupe-b', 'dedupe-a']])
    // The failed pass decides nothing for the sub-agents; every later pass alerts exactly as without the failure.
    expect(failed[2]).toEqual([MAIN_AGENT_ID])
    expect(failed.filter((_, i) => i !== 2)).toEqual(clean.filter((_, i) => i !== 2))
  })
})
