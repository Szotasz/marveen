// The context-guard's delivery hold (contextGuardDeliveryHold, registered into
// delivery-hold.ts at start): held from the handoff request until the fresh
// session has its resume prompt, released after, and never past the phase
// deadline. Driven through the REAL runner and state machine (same harness as
// context-guard-idle-flush-restart-notice.test.ts): idle-flush request ->
// handoff written -> restart -> resume.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(homedir(), '.cghold-test-'))
const STORE = join(ROOT, 'store')

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: ROOT,
}))
const warn = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() },
}))

const T0 = 1_790_000_000_000
const MIN = 60_000

// A healthy idle pane: input box and the bypass footer, no saturation banner.
const IDLE_PANE = ['  done.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

const h = vi.hoisted(() => ({
  worksource: false,
  messages: [] as string[],
  ready: false,
  // When set, a resume send waits on it: holds the send open.
  sendGate: null as Promise<void> | null,
  resumeSends: 0,
  restartAt: 0,
}))

vi.mock('../web/context-guard-store.js', async () => {
  const { normalizeContextGuardConfig } = await import('../context-guard.js')
  return { readContextGuardConfig: () => normalizeContextGuardConfig({ idleFlushEnabled: true, idleMinutes: 20 }) }
})
vi.mock('../web/agent-process.js', () => ({
  agentRunState: () => 'running',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess: async () => { h.restartAt = Date.now(); return { ok: true } },
  capturePane: (s: string) => (s.startsWith('agent-') ? IDLE_PANE : null),
  isSessionReadyForPrompt: async () => h.ready,
  noteSaturationBannerUntrusted: () => {},
  clearSaturationBannerOverride: () => {},
}))
vi.mock('../web/system-directive.js', () => ({
  sendSystemDirective: async (_name: string, _session: string, text: string) => {
    if (String(text).includes('Friss kontextussal')) {
      h.resumeSends++
      if (h.sendGate) await h.sendGate
    }
    return 'sent'
  },
}))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => ({ ok: true }),
  lastMainRespawnAt: () => null,
  MARVEEN_POST_RESPAWN_GRACE_MS: 0,
  markAgentRestartPending: () => {},
}))
vi.mock('../web/stuck-tool-call-watcher.js', () => ({ shouldDeferForRecentRespawn: () => false }))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['boni'],
  listAllAgentNames: () => ['boni'],
  agentDir: (n: string) => join(ROOT, 'agents', n),
  readAgentModel: () => null,
  readAgentRemoteHost: () => null,
  readAgentWorksourceChannel: () => h.worksource,
}))
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => undefined }))
vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => 600_000, // past idleFlushTokens
  readActiveModelFromProjectDir: () => null,
  readTranscriptMtimeFromProjectDir: () => T0 - 120 * MIN, // quiet for 2 h
  readTranscriptTailFromProjectDir: () => null,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))
vi.mock('../notify.js', () => ({ notifyChannel: async () => {} }))
vi.mock('../db.js', () => ({
  createAgentMessage: (_from: string, _to: string, content: string, tag?: string) => {
    if (tag === 'context-guard restart notice') h.messages.push(content)
    return { id: 1 }
  },
}))

type Runner = typeof import('../web/context-guard-runner.js')
let timers: NodeJS.Timeout[] = []

type Hold = typeof import('../web/delivery-hold.js')

/** A fresh dashboard process. The hold registry is read back from the SAME module
 *  graph the runner registered into (resetModules gives each boot its own). */
async function boot(): Promise<{ runner: Runner; hold: Hold }> {
  vi.resetModules()
  const runner = await import('../web/context-guard-runner.js')
  const hold = await import('../web/delivery-hold.js')
  timers.push(runner.startContextGuardRunner())
  return { runner, hold }
}

beforeEach(() => {
  h.ready = false
  h.sendGate = null
  h.resumeSends = 0
  warn.mockClear()
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })
  mkdirSync(join(ROOT, 'agents', 'boni'), { recursive: true })
  rmSync(join(ROOT, 'agents', 'boni', 'HANDOFF.md'), { force: true })
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  h.worksource = true
  h.messages = []
})

afterEach(() => {
  for (const t of timers) clearInterval(t)
  timers = []
  vi.clearAllTimers()
  vi.useRealTimers()
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Idle-flush request at the first sweep; returns once the guard waits for the handoff. */
async function toAwaitHandoff(runner: Runner): Promise<void> {
  await vi.advanceTimersByTimeAsync(4.5 * MIN)
  expect(runner.getHardGuardPhase('boni')).toBe('await-handoff')
}

/** The agent writes its handoff, the next sweep restarts it; the fresh pane is not ready yet. */
async function toAwaitReady(runner: Runner): Promise<void> {
  await toAwaitHandoff(runner)
  writeFileSync(join(ROOT, 'agents', 'boni', 'HANDOFF.md'), '# handoff\n')
  await vi.advanceTimersByTimeAsync(5 * MIN)
  expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
}

describe('context-guard delivery hold, through the real runner', () => {
  it('not held while idle; held through await-handoff and await-ready; released once the resume is in', async () => {
    const { runner, hold } = await boot()
    expect(hold.deliveryHoldFor('boni', Date.now())).toBeNull()

    await toAwaitHandoff(runner)
    expect(hold.deliveryHoldFor('boni', Date.now())).toMatchObject({ phase: 'await-handoff' })

    writeFileSync(join(ROOT, 'agents', 'boni', 'HANDOFF.md'), '# handoff\n')
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(runner.getHardGuardPhase('boni')).toBe('await-ready')
    expect(hold.deliveryHoldFor('boni', Date.now())).toMatchObject({ phase: 'await-ready' })

    h.ready = true
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(h.resumeSends).toBe(1)
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
    expect(hold.deliveryHoldFor('boni', Date.now())).toBeNull()
    // Released by the phase, not by a lapse: nothing in this sequence ran out.
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('delivery hold lapsed'))).toHaveLength(0)
  })

  it('another agent is never held by this one\'s restart', async () => {
    const { runner, hold } = await boot()
    await toAwaitReady(runner)
    expect(hold.deliveryHoldFor('ana', Date.now())).toBeNull()
  })

  it('fail-open: the hold lapses at the phase deadline plus one sweep, with one warning', async () => {
    const { runner, hold } = await boot()
    await toAwaitReady(runner)
    const live = hold.deliveryHoldFor('boni', Date.now())
    // The ready deadline (restart + 20 min) plus one 5-minute sweep.
    expect(live?.untilMs).toBe(h.restartAt + 20 * MIN + 5 * MIN)

    const at = live!.untilMs as number
    expect(hold.deliveryHoldFor('boni', at - 1)).not.toBeNull()
    expect(hold.deliveryHoldFor('boni', at)).toBeNull()
    expect(hold.deliveryHoldFor('boni', at + 60_000)).toBeNull()
    const lapsed = warn.mock.calls.filter((c) => String(c[1]).includes('delivery hold lapsed'))
    expect(lapsed).toHaveLength(1)
  })

  it('held while the sweep types the resume prompt, although the phase already says cooldown', async () => {
    const { runner, hold } = await boot()
    await toAwaitReady(runner)
    // Only the sweep is left to deliver (the immediate-delivery loop's sleep dies
    // with the timers; its registration stays, so no new loop starts).
    for (const t of timers) clearInterval(t)
    timers = []
    const now = Date.now()
    vi.clearAllTimers()
    vi.setSystemTime(now)
    timers.push(runner.startContextGuardRunner())

    let release!: () => void
    h.sendGate = new Promise<void>((resolve) => { release = resolve })
    h.ready = true
    await vi.advanceTimersByTimeAsync(4.5 * MIN)
    expect(h.resumeSends).toBe(1)
    expect(runner.getHardGuardPhase('boni')).toBe('cooldown')
    const sending = hold.deliveryHoldFor('boni', Date.now())
    expect(sending).toMatchObject({ phase: 'resume-sending' })
    // Bounded by how long a resume can be owed (30 min) plus one sweep: a send that
    // never returns cannot keep the inbox shut.
    expect(sending!.untilMs).toBe(h.restartAt + 30 * MIN + 5 * MIN)
    expect(hold.deliveryHoldFor('boni', sending!.untilMs - 1)).not.toBeNull()
    expect(hold.deliveryHoldFor('boni', sending!.untilMs)).toBeNull()
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('delivery hold lapsed'))).toHaveLength(1)

    h.sendGate = null
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(hold.deliveryHoldFor('boni', Date.now())).toBeNull()
  })
})
