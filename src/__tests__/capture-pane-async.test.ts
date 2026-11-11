import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pane: ['', '─'.repeat(80), '❯ ', '─'.repeat(80), '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n'),
  probeFired: false,
  finishes: [] as boolean[],
  calls: [] as { async: boolean; file: string; args: string[]; opts: { timeout?: number } }[],
  fail: false,
  killed: false,
  syncPane: null as string | null,
}))

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFileSync: vi.fn((file: string, args: string[], opts: { timeout?: number }) => {
    h.calls.push({ async: false, file, args, opts })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    h.finishes.push(h.probeFired)
    if (h.fail) throw new Error('capture failed')
    return h.syncPane ?? h.pane
  }),
  execFile: vi.fn((file: string, args: string[], opts: { timeout?: number }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    h.calls.push({ async: true, file, args, opts })
    setTimeout(() => {
      h.finishes.push(h.probeFired)
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

beforeEach(() => {
  h.probeFired = false
  h.finishes.length = 0
  h.calls.length = 0
  h.fail = false
  h.killed = false
  h.syncPane = null
})

describe('async capture leaves the event loop responsive', () => {
  it('readiness: probe timer fired before the first capture finished', async () => {
    const probe = setTimeout(() => { h.probeFired = true }, 20)
    try {
      expect(await agentProcess.isSessionReadyForPrompt('agent-x')).toBe(true)
      expect(h.finishes[0], 'probe timer fired before first capture finished').toBe(true)
    } finally { clearTimeout(probe) }
  })

  it('recovery: probe timer fired before the capture finished', async () => {
    const probe = setTimeout(() => { h.probeFired = true }, 20)
    try {
      await recoverStuckInputForSession('agent-x', { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }, { confirmMs: 1000, dedupMs: 1000, maxAttempts: 3 }, true)
      expect(h.finishes[0], 'probe timer fired before first capture finished').toBe(true)
    } finally { clearTimeout(probe) }
  })
})

describe.skipIf(process.env.CAPTURE_ASYNC_RED_CONTROL === '1')('async capture contract', () => {
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
    } finally { h.pane = previous }
  })

  it('recovery with nothing parked makes no synchronous capture calls', async () => {
    await recoverStuckInputForSession('agent-x', { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }, { confirmMs: 1000, dedupMs: 1000, maxAttempts: 3 }, true)
    // Not vacuous: the recovery did read the pane, asynchronously.
    expect(h.calls.filter(call => call.async && call.args.includes('capture-pane')).length).toBeGreaterThan(0)
    expect(h.calls.filter(call => !call.async && call.args.includes('capture-pane'))).toHaveLength(0)
  })
})
