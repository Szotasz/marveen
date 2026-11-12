import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import { startStuckInputWatcher } from '../web/stuck-input-watcher.js'
import { startReauthHealer } from '../web/reauth-healer.js'
import { startChannelIntakeMonitor } from '../web/channel-intake-monitor.js'

const h = vi.hoisted(() => ({
  agents: ['dedupe-b', 'dedupe-c', 'dedupe-a'],
  sessions: 'agent-dedupe-b\nagent-dedupe-a\n',
  listError: null as unknown,
  spawns: [] as Array<{ file: string; args: string[] }>,
  hostReads: [] as string[],
}))

// Keep agent-process real: only its child-process boundary is faked.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = (file: string, args: readonly string[] = []) => {
    h.spawns.push({ file, args: [...args] })
    if (args[0] === 'list-sessions') {
      if (h.listError !== null) throw h.listError
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
  readAgentRemoteHost: (name: string) => { h.hostReads.push(name); return null },
  readAgentRunAsUser: () => null,
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

  it('stuck-input: a timed-out list-sessions resets one pass and starts, messages, alerts nothing', async () => {
    const deletes = vi.spyOn(Map.prototype, 'delete')
    startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(15_000)
    const maps = deletedMaps(deletes, 'agent-dedupe-c')
    expect(maps).toHaveLength(1)
    for (const session of runningOrder) maps[0].set(session, { parkedSig: 'stale' })

    h.listError = listTimeoutError()
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(5_000)
    expectOnlyListAndMainCaptures()
    for (const session of runningOrder) expect(maps[0].has(session)).toBe(false)

    h.listError = null
    h.spawns.length = 0
    // Repeat the same advance to reach the next interval after the initial timeout.
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(panes()).toEqual([MAIN_CHANNELS_SESSION, MAIN_CHANNELS_SESSION,
      runningOrder[0], runningOrder[0], runningOrder[1], runningOrder[1]])
    expectOneListSpawn()
  })

  it('reauth: a timed-out list-sessions resets one pass and starts, messages, alerts nothing', async () => {
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
      for (const session of runningOrder) expect(map.has(session)).toBe(false)
    }

    h.listError = null
    h.spawns.length = 0
    await vi.advanceTimersByTimeAsync(90_000)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(panes()).toEqual([MAIN_CHANNELS_SESSION, ...runningOrder])
    expectOneListSpawn()
  })

  it('intake: a timed-out list-sessions resets one pass and starts, messages, alerts nothing', async () => {
    h.agents = [MAIN_AGENT_ID, ...h.agents]
    const deletes = vi.spyOn(Map.prototype, 'delete')
    startChannelIntakeMonitor('/unused-project')
    await vi.advanceTimersByTimeAsync(100_000)
    const maps = deletedMaps(deletes, 'dedupe-c')
    expect(maps).toHaveLength(1)
    for (const name of ['dedupe-b', 'dedupe-a']) {
      maps[0].set(name, { at: 1, pendingUpdates: 99 })
    }

    h.listError = listTimeoutError()
    h.spawns.length = 0
    vi.mocked(fetch).mockClear()
    await vi.advanceTimersByTimeAsync(200_000)
    expectOnlyListAndMainCaptures()
    for (const name of ['dedupe-b', 'dedupe-a']) expect(maps[0].has(name)).toBe(false)
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
  })
})
