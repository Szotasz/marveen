import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RECONCILE_GAP_POLL_MS, RECONCILE_MAIN_FIRST_MAX_WAIT_MS, RECONCILE_MAX_GAP_MS, RECONCILE_MIN_GAP_MS,
  mainFirstGate, runReconcileBurst, waitReconcileGap, type ReconcileBurstDeps,
} from '../web/reconcile-stagger.js'

// BOOTSTAGGER1007 (c). Measured 2026-10-07 after a power cut: the reconcile
// started a sub-agent every 15 s next to the booting main session, while one
// session with its MCP servers needs longer than that, so 15 boots overlapped
// (load 21). Now: main first, then one agent at a time by readiness or a quiet
// box, both bounded.

describe('mainFirstGate', () => {
  it('a ready main session lets the reconcile go at once', () => {
    expect(mainFirstGate(true, 0)).toBe('go')
  })
  it('a main session not ready yet holds the sub-agents...', () => {
    expect(mainFirstGate(false, 0)).toBe('wait')
    expect(mainFirstGate(false, RECONCILE_MAIN_FIRST_MAX_WAIT_MS - 1)).toBe('wait')
  })
  it('...but never past the cap, so a main session that never comes up does not keep the fleet down', () => {
    expect(RECONCILE_MAIN_FIRST_MAX_WAIT_MS).toBe(5 * 60 * 1000)
    expect(mainFirstGate(false, RECONCILE_MAIN_FIRST_MAX_WAIT_MS)).toBe('go')
  })
})

// A fake clock: sleep advances it; the probes read it. A hard cap on sleeps
// turns a wait that never ends (e.g. a sleep that stops advancing the clock)
// into a failure instead of a hung run -- the loop only awaits resolved
// promises, so vitest's own test timeout cannot fire.
function clock() {
  let t = 1_000_000
  let sleeps = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      if (++sleeps > 1_000) throw new Error('waitReconcileGap did not end within 1000 sleeps')
      if (ms < 0) throw new Error(`negative sleep (${ms} ms)`)
      t += ms
    },
    at: () => t,
  }
}

describe('waitReconcileGap', () => {
  it('never shorter than the minimum gap (the resume-modal race), even when the agent is ready at once', async () => {
    const c = clock()
    const r = await waitReconcileGap({ ...c, isReady: async () => true, loadPerCpu: () => 0 })
    expect(RECONCILE_MIN_GAP_MS).toBe(15_000)
    expect(r).toEqual({ end: 'ready', waitedMs: RECONCILE_MIN_GAP_MS })
  })

  it('a loaded box: waits until the agent is ready, not a fixed clock', async () => {
    const c = clock()
    const t0 = c.at()
    const r = await waitReconcileGap({ ...c, isReady: async () => c.at() - t0 >= 40_000, loadPerCpu: () => 5 })
    expect(r.end).toBe('ready')
    expect(r.waitedMs).toBeGreaterThanOrEqual(40_000)
    expect(r.waitedMs).toBeLessThan(40_000 + RECONCILE_GAP_POLL_MS + 1)
  })

  it('a quiet box goes on after the minimum even if the agent is still booting', async () => {
    const c = clock()
    const r = await waitReconcileGap({ ...c, isReady: async () => false, loadPerCpu: () => 0.4 })
    expect(r).toEqual({ end: 'load', waitedMs: RECONCILE_MIN_GAP_MS })
  })

  it('a stuck agent on a loaded box holds the rest at most RECONCILE_MAX_GAP_MS', async () => {
    const c = clock()
    const r = await waitReconcileGap({ ...c, isReady: async () => false, loadPerCpu: () => 9 })
    expect(RECONCILE_MAX_GAP_MS).toBe(90_000)
    expect(r).toEqual({ end: 'max', waitedMs: RECONCILE_MAX_GAP_MS })
  })

  it('an unknown load is not "quiet": it waits for ready or the max', async () => {
    const c = clock()
    const r = await waitReconcileGap({ ...c, isReady: async () => false, loadPerCpu: () => null })
    expect(r.end).toBe('max')
  })

  it('the load threshold is per CPU, strictly below 1.0', async () => {
    const c = clock()
    expect((await waitReconcileGap({ ...c, isReady: async () => false, loadPerCpu: () => 1.0 })).end).toBe('max')
  })
})

// #1764 review (Samu): the gate's WIRING had no assertion of its own -- a
// mutant `if (false && mainFirstGate(...))` stayed green under the source pin.
// The burst is now a function with injected deps, and these tests drive it.
describe('runReconcileBurst: the main-first gate actually holds the starts', () => {
  function burst(over: Partial<ReconcileBurstDeps> = {}) {
    const events: string[] = []
    let mainAsked = 0
    const deps: ReconcileBurstDeps = {
      down: ['boni', 'dani', 'zara'],
      mainReady: () => { mainAsked++; return true },
      msSinceMonitorStart: 0,
      isAgentRunning: () => false,
      isRestartInFlight: () => false,
      isWithinRestartGrace: () => false,
      memGateAllowsStart: () => true,
      start: async (n) => { events.push(`start:${n}`); return { ok: true } },
      afterStart: (n) => { events.push(`after:${n}`) },
      gap: async (n) => { events.push(`gap:${n}`); return { end: 'ready', waitedMs: 15_000 } },
      log: () => {},
      ...over,
    }
    return { deps, events, mainAsked: () => mainAsked }
  }

  it('main session NOT ready (inside the cap): the burst returns before a single start', async () => {
    const b = burst({ mainReady: () => false, msSinceMonitorStart: 60_000 })
    const r = await runReconcileBurst(b.deps)
    expect(r).toEqual({ gate: 'wait', started: [] })
    expect(b.events).toEqual([])
  })

  it('main session ready: each down agent is started in order, its gap waited before the next', async () => {
    const b = burst()
    const r = await runReconcileBurst(b.deps)
    expect(r).toEqual({ gate: 'go', started: ['boni', 'dani', 'zara'] })
    expect(b.events).toEqual([
      'start:boni', 'after:boni', 'gap:boni',
      'start:dani', 'after:dani', 'gap:dani',
      'start:zara', 'after:zara', 'gap:zara',
    ])
    expect(b.mainAsked()).toBe(1)
  })

  it('main session never ready, past the cap: the fleet starts anyway', async () => {
    const b = burst({ mainReady: () => false, msSinceMonitorStart: RECONCILE_MAIN_FIRST_MAX_WAIT_MS })
    expect((await runReconcileBurst(b.deps)).started).toEqual(['boni', 'dani', 'zara'])
  })

  it('nothing down: the main session is not even probed', async () => {
    const b = burst({ down: [] })
    expect(await runReconcileBurst(b.deps)).toEqual({ gate: 'go', started: [] })
    expect(b.mainAsked()).toBe(0)
  })

  it('the old skips still hold: running, a managed restart in flight, the restart grace, the memory gate', async () => {
    const b = burst({
      down: ['up', 'restarting', 'graced', 'memblocked', 'ok'],
      isAgentRunning: (n) => n === 'up',
      isRestartInFlight: (n) => n === 'restarting',
      isWithinRestartGrace: (n) => n === 'graced',
      memGateAllowsStart: (n) => n !== 'memblocked',
    })
    expect((await runReconcileBurst(b.deps)).started).toEqual(['ok'])
  })

  it('one agent failing to start does not stop the burst, and its gap is still waited', async () => {
    const b = burst({
      start: async (n) => {
        b.events.push(`start:${n}`)
        if (n === 'boni') throw new Error('boom')
        if (n === 'dani') return { ok: false, error: 'tmux failed' }
        return { ok: true }
      },
    })
    const r = await runReconcileBurst(b.deps)
    expect(r.started).toEqual(['boni', 'dani', 'zara'])
    expect(b.events.filter((e) => e.startsWith('gap:'))).toEqual(['gap:boni', 'gap:dani', 'gap:zara'])
  })
})

describe('the binding in the reconcile (source)', () => {
  const src = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
  const fn = src.slice(src.indexOf('async function reconcileDesiredAgents'), src.indexOf('// Backward-compatible alias'))

  it('the reconcile delegates the whole burst, with the REAL main readiness and the agent\'s own readiness gap', () => {
    expect(fn).toContain('await runReconcileBurst({')
    expect(fn).toContain('mainReady: mainSessionChannelsReady,')
    expect(fn).toContain('msSinceMonitorStart: Date.now() - monitorModuleLoadedAt,')
    expect(fn).toContain('isReady: () => isSessionReadyForPrompt(agentSessionName(name)),')
    expect(fn).toContain('memGateAllowsStart,')
  })

  it('no start bypasses the burst: startAgentProcess appears only as the injected start', () => {
    expect(fn.match(/startAgentProcess\(/g)?.length).toBe(1)
    expect(fn).toContain('start: (name) => startAgentProcess(name),')
    expect(fn).not.toMatch(/await delay\(/)
  })

  it('main readiness = the primary plugin AND every co-listen plugin alive under the main claude, strict', () => {
    const ready = src.slice(src.indexOf('function mainSessionChannelsReady'), src.indexOf('function loadPerCpu'))
    expect(ready).toContain('probeChannelPluginLiveness(claudePid, primary) !== \'alive\'')
    expect(ready).toContain('colistenProviders(primary, readExtraChannelPluginIds()')
    expect(ready).toContain("extras.every((p) => probeChannelPluginLiveness(claudePid, p, undefined, { strictTree: true }) === 'alive')")
  })
})
