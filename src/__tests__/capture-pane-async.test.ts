import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pane: ['', '─'.repeat(80), '❯ ', '─'.repeat(80), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'),
  probeFired: false,
  finishes: [] as { async: boolean; args: string[]; fired: boolean }[],
  probes: new Set<ReturnType<typeof setTimeout>>(),
  calls: [] as { async: boolean; file: string; args: string[]; opts: { timeout?: number; killSignal?: string } }[],
  fail: false,
  killed: false,
  hang: false,
  lateCb: null as ((err: Error | null, stdout: string, stderr: string) => void) | null,
  killSignals: [] as (string | undefined)[],
  syncPane: null as string | null,
}))

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn((file: string, args: string[], opts: { timeout?: number }) => {
    h.probeFired = false
    const probe = setTimeout(() => { h.probeFired = true }, 20)
    h.probes.add(probe)
    h.calls.push({ async: false, file, args, opts })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    h.finishes.push({ async: false, args, fired: h.probeFired })
    clearTimeout(probe)
    h.probes.delete(probe)
    if (h.fail) throw new Error('capture failed')
    return h.syncPane ?? h.pane
  }),
  execFile: vi.fn((file: string, args: string[], opts: { timeout?: number; killSignal?: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    h.probeFired = false
    const probe = setTimeout(() => { h.probeFired = true }, 20)
    h.probes.add(probe)
    h.calls.push({ async: true, file, args, opts })
    if (h.hang) {
      h.lateCb = cb
      clearTimeout(probe)
      h.probes.delete(probe)
      return { stdin: { end() {} }, killed: false, kill: (sig?: string) => { h.killSignals.push(sig); return true } }
    }
    setTimeout(() => {
      h.finishes.push({ async: true, args, fired: h.probeFired })
      clearTimeout(probe)
      h.probes.delete(probe)
      cb(h.fail ? new Error('capture failed') : null, h.fail ? '' : h.pane, '')
    }, 200)
    return { stdin: { end() {} }, killed: h.killed }
  }),
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../platform.js', async (orig) => ({
  ...(await orig<typeof import('../platform.js')>()),
  makeLazyBinResolver: (name: string) => () => `/usr/local/bin/${name}`,
}))
vi.mock('../notify.js', () => ({ alertIsRedirected: () => false, notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import * as agentProcess from '../web/agent-process.js'
import { recoverStuckInputForSession } from '../web/channel-monitor.js'
import { stuckInputSignature } from '../pane-state.js'

function clearProbes() {
  for (const probe of h.probes) clearTimeout(probe)
  h.probes.clear()
}

afterEach(clearProbes)

beforeEach(() => {
  clearProbes()
  h.probeFired = false
  h.finishes.length = 0
  h.calls.length = 0
  h.fail = false
  h.killed = false
  h.hang = false
  h.lateCb = null
  h.killSignals.length = 0
  h.syncPane = null
})

describe('async capture leaves the event loop responsive', () => {
  it('readiness: probe timer fired before the first capture finished', async () => {
    expect(await agentProcess.isSessionReadyForPrompt('agent-x')).toBe(true)
    expect(h.finishes[0].fired, 'probe timer fired before first capture finished').toBe(true)
  })

  it('recovery: probe timer fired before the capture finished', async () => {
    await recoverStuckInputForSession('agent-x', { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }, { confirmMs: 1000, dedupMs: 1000, maxAttempts: 3 }, true)
    expect(h.finishes[0].fired, 'probe timer fired before first capture finished').toBe(true)
  })

  function expectResponsiveCaptures(expectedCount?: number) {
    const calls = h.calls.filter(call => call.args.includes('capture-pane'))
    expect(calls.length, 'at least one capture-pane call was made').toBeGreaterThan(0)
    if (expectedCount !== undefined) expect(calls).toHaveLength(expectedCount)
    const finishes = h.finishes.filter(finish => finish.args.includes('capture-pane'))
    expect(finishes).toHaveLength(calls.length)
    for (const [index, call] of calls.entries()) {
      expect(call.async, `capture-pane call ${index + 1} must be async`).toBe(true)
      expect(finishes[index].fired, `probe timer fired during capture-pane call ${index + 1}`).toBe(true)
    }
  }

  it('clearStaleParkedInput: every capture yields to the probe timer', async () => {
    expect(await agentProcess.clearStaleParkedInput('agent-x')).toBe(false)
    expectResponsiveCaptures()
  })

  it('clearFeedbackModalAndRecheck: every capture yields to the probe timer', async () => {
    expect(await agentProcess.clearFeedbackModalAndRecheck('agent-x')).toBe(false)
    expectResponsiveCaptures()
  })

  it('readiness: both captures yield to their own probe timer', async () => {
    expect(await agentProcess.isSessionReadyForPrompt('agent-x')).toBe(true)
    expectResponsiveCaptures(2)
  })
})

describe('async capture contract', () => {
  it('matches both sync post-processing contracts and returns null on errors', async () => {
    const previous = h.pane
    h.pane = '\x1b[32mReady\x1b[0m\n❯ \x1b[2mghost hint\x1b[0m\n\x1b[48;5;236m session title \x1b[0m'
    try {
      expect(await agentProcess.capturePaneAsync('agent-x')).toBe(agentProcess.capturePane('agent-x'))
      expect(await agentProcess.captureParkedInputViewAsync('agent-x')).toBe(agentProcess.captureParkedInputView('agent-x'))
      h.fail = true
      expect(await agentProcess.capturePaneAsync('agent-x')).toBeNull()
      expect(await agentProcess.captureParkedInputViewAsync('agent-x')).toBeNull()
    } finally { h.pane = previous }
  })

  it('uses the same local tmux argv as each sync twin and a 3000 ms timeout', async () => {
    for (const [sync, asyncCapture] of [
      [agentProcess.capturePane, agentProcess.capturePaneAsync],
      [agentProcess.captureParkedInputView, agentProcess.captureParkedInputViewAsync],
    ]) {
      h.calls.length = 0
      sync('agent-x', null)
      await asyncCapture('agent-x', null)
      expect(h.calls).toHaveLength(2)
      expect(h.calls[1].args).toEqual(h.calls[0].args)
      expect(h.calls[1].file).toBe(h.calls[0].file)
      expect(h.calls[1].async).toBe(true)
      expect(h.calls[1].opts.timeout).toBe(3000)
    }
  })
})

describe('async capture timeout and recovery parity', () => {
  it('returns null for a killed client even when it exits successfully with empty output', async () => {
    const previous = h.pane
    h.pane = ''
    h.killed = true
    try {
      expect(await agentProcess.capturePaneAsync('agent-x')).toBeNull()
      expect(await agentProcess.captureParkedInputViewAsync('agent-x')).toBeNull()
      h.killed = false
      expect(await agentProcess.capturePaneAsync('agent-x')).toBeTypeOf('string')
    } finally { h.pane = previous }
  })

  it('recovery decides on a fresh synchronous read of parked input', async () => {
    const previous = h.pane
    const parkedPane = (text: string) => ['', '─'.repeat(80), `❯ ${text}`, '─'.repeat(80), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    const p = parkedPane('first parked message')
    const q = parkedPane('different parked message')
    h.pane = p
    h.syncPane = q
    try {
      expect(stuckInputSignature(p)).not.toBeNull()
      expect(stuckInputSignature(q)).not.toBeNull()
      expect(stuckInputSignature(p)).not.toBe(stuckInputSignature(q))
      const next = await recoverStuckInputForSession('agent-x', { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }, { confirmMs: 1000, dedupMs: 1000, maxAttempts: 3 }, true)
      expect(next.parkedSig).toBe(stuckInputSignature(q))
      const captures = h.calls.filter(call => call.args.includes('capture-pane'))
      expect(captures.filter(call => !call.async)).toHaveLength(1)
      const syncIndex = h.calls.findIndex(call => !call.async && call.args.includes('capture-pane'))
      expect(h.calls.slice(0, syncIndex).some(call => call.async && call.args.includes('capture-pane')),
        'an async capture-pane call preceded the fresh synchronous read').toBe(true)
    } finally { h.pane = previous }
  })

  it('recovery with nothing parked makes no synchronous capture calls', async () => {
    await recoverStuckInputForSession('agent-x', { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }, { confirmMs: 1000, dedupMs: 1000, maxAttempts: 3 }, true)
    // Not vacuous: the recovery did read the pane, asynchronously.
    expect(h.calls.filter(call => call.async && call.args.includes('capture-pane')).length).toBeGreaterThan(0)
    expect(h.calls.filter(call => !call.async && call.args.includes('capture-pane'))).toHaveLength(0)
  })
})

describe('async capture never hangs on a child that does not exit', () => {
  it('kills the child with SIGKILL and settles to null after timeout plus grace', async () => {
    vi.useFakeTimers()
    try {
      h.hang = true
      for (const capture of [agentProcess.capturePaneAsync, agentProcess.captureParkedInputViewAsync]) {
        h.calls.length = 0
        h.killSignals.length = 0
        let settled = false
        let value: string | null | undefined
        const p = capture('agent-x', null).then(v => { settled = true; value = v })
        await vi.advanceTimersByTimeAsync(3000 + 999)
        expect(settled, 'still waiting inside the grace period').toBe(false)
        await vi.advanceTimersByTimeAsync(2)
        expect(settled, 'the call settled after timeout plus grace').toBe(true)
        await p
        expect(value).toBeNull()
        expect(h.killSignals).toEqual(['SIGKILL'])
        expect(h.calls[0].opts.killSignal).toBe('SIGKILL')
      }
    } finally {
      h.hang = false
      vi.useRealTimers()
    }
  })

  it('ignores a late callback after the fallback has settled the call', async () => {
    vi.useFakeTimers()
    try {
      h.hang = true
      let value: string | null | undefined = 'unset'
      const p = agentProcess.capturePaneAsync('agent-x', null).then(v => { value = v })
      await vi.advanceTimersByTimeAsync(3000 + 1001)
      await p
      expect(value).toBeNull()
      expect(h.lateCb).not.toBeNull()
      expect(() => h.lateCb!(null, 'late output', '')).not.toThrow()
      await vi.advanceTimersByTimeAsync(10)
      expect(value).toBeNull()
      expect(h.killSignals).toEqual(['SIGKILL'])
    } finally {
      h.hang = false
      vi.useRealTimers()
    }
  })

  it('a normal capture clears its fallback timer and never kills the child', async () => {
    vi.useFakeTimers()
    try {
      const p = agentProcess.capturePaneAsync('agent-x', null)
      await vi.advanceTimersByTimeAsync(200)
      expect(await p).toBeTypeOf('string')
      expect(vi.getTimerCount(), 'no timer left pending after a normal capture').toBe(0)
      await vi.advanceTimersByTimeAsync(3000 + 1001)
      expect(h.killSignals).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
