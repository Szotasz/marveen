import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'

// 0038ce9c: after sending /clear to the interactive worker, the agent-worker
// must wait for the PANE to return to an empty prompt before delivering the
// next prompt. Today it sleeps a FIXED 0.2s + 0.5s and sends unconditionally:
// on a loaded machine the TUI has not even processed the /clear by then
// (Cowork measurement, spec comment 27730: /clear lands within 3.5s under
// load ~20), so the prompt keystrokes go into a busy/picker pane and the
// request is lost -- measured as worker timeouts in dashboard.log.
//
// This is a BEHAVIOURAL timing test: the real runViaWorker path runs against
// a wall-clock-driven fake TUI whose /clear takes T_READY_MS to process (the
// "slow TUI under load" simulation). The fixed sleeps are executed as REAL
// synchronous sleeps (Atomics.wait), so the 0.2+0.5s of the current code
// genuinely elapse. The contract under test: the prompt send must not happen
// while the pane is still processing /clear.

// Default: how long the simulated TUI needs to actually execute /clear after Enter
// (well above the old fixed 0.2+0.5s wait, below the run timeout budget). Per-test
// override via state.readyDelayMs: 0 = the pane never goes busy (the stale-window
// shape of the R1 review corner: the pane still shows an idle prompt right after
// Enter), 10s = beyond the 8s fail-open budget.
const T_READY_MS = 2500

const tui = vi.hoisted(() => {
  const SEP = '─'.repeat(80)
  const state = {
    // Wall-clock times (ms) of the observed events.
    clearTextAt: 0,
    enterAt: 0,
    readyAt: 0, // 0 = idle; set to enterAt+readyDelayMs once /clear's Enter lands
    readyDelayMs: 2500,
    promptSendAt: null as number | null,
    promptSentWhileBusy: false,
    inputBox: '',
    sendKeysCalls: [] as Array<{ at: number; tail: string[] }>,
    acceptedOutPath: null as string | null,
    acceptedDonePath: null as string | null,
  }
  const busy = (): boolean => state.readyAt > 0 && Date.now() < state.readyAt
  const pane = (): string =>
    busy()
      ? ['', '· clearing context …'].join('\n')
      : ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
  const reset = (): void => {
    state.clearTextAt = 0
    state.enterAt = 0
    state.readyAt = 0
    state.readyDelayMs = 2500
    state.promptSendAt = null
    state.promptSentWhileBusy = false
    state.inputBox = ''
    state.sendKeysCalls.length = 0
    state.acceptedOutPath = null
    state.acceptedDonePath = null
  }
  return { state, busy, pane, reset }
})

// Captured logger.warn messages, so the exhaustion log is assertable (R2).
const warnLog = vi.hoisted((): string[] => [])

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  // Real synchronous sleep: the fixed-wait code paths under test must
  // actually elapse their 0.2s / 0.5s, or the measurement would be fake.
  const syncSleepMs = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }
  const fakeExecFileSync = (file: string, args: readonly string[], _opts?: unknown): string => {
    tui.state.sendKeysCalls.push({ at: Date.now(), tail: [...args.slice(0, 6)] })
    if (file === '/bin/sleep') {
      syncSleepMs(Math.round(parseFloat(args[0]) * 1000))
      return ''
    }
    if (args[0] === 'send-keys') {
      const litIdx = args.indexOf('-l')
      if (litIdx !== -1) {
        if (tui.busy()) return '' // keystrokes into a busy TUI are lost
        tui.state.inputBox += args[litIdx + 1] ?? ''
        if (tui.state.inputBox.includes('/clear')) tui.state.clearTextAt = Date.now()
        return ''
      }
      const key = args[args.length - 1]
      if (key === 'Enter' && !tui.busy() && tui.state.inputBox.trim() === '/clear') {
        // The TUI accepts the /clear and takes readyDelayMs to process it
        // (the loaded-machine case: the pane shows no idle prompt meanwhile).
        tui.state.enterAt = Date.now()
        tui.state.readyAt = tui.state.enterAt + tui.state.readyDelayMs
        tui.state.inputBox = ''
        return ''
      }
      return ''
    }
    if (args[0] === 'capture-pane' || args[0] === 'display-message') return tui.pane()
    return ''
  }
  return { ...actual, execFileSync: fakeExecFileSync }
})

vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>()
  const base = ('logger' in actual && actual.logger) ? actual.logger : ({} as Record<string, unknown>)
  return {
    ...actual,
    logger: {
      ...base,
      warn: (bindings: unknown, message?: unknown) => { warnLog.push(String(message ?? bindings)) },
    },
  }
})

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    capturePane: (): string | null => tui.pane(),
    isSessionReadyForPrompt: async (): Promise<boolean> => !tui.busy(),
    sessionExistsOnHost: (): boolean => true,
    sendPromptToSession: async (
      _session: string,
      text: string,
      _host: string | null,
    ): Promise<'sent'> => {
      tui.state.promptSendAt = Date.now()
      if (tui.busy()) {
        // Real-world failure mode: tmux "succeeds" but the keystrokes land in
        // a pane that is still processing /clear -- the prompt is lost.
        tui.state.promptSentWhileBusy = true
        return 'sent'
      }
      // Accepted: the fake worker writes the transport files shortly after.
      const out = /(\S+\.out)(?:\s|$)/.exec(text)?.[1] ?? null
      const done = /(\S+\.done)(?:\s|$)/.exec(text)?.[1] ?? null
      if (out && done) {
        tui.state.acceptedOutPath = out
        tui.state.acceptedDonePath = done
        const { writeFileSync } = await import('node:fs')
        setTimeout(() => {
          try {
            writeFileSync(out, 'fake worker answer')
            writeFileSync(done, 'done')
          } catch { /* test cleanup territory */ }
        }, 50)
      }
      return 'sent'
    },
  }
})

import { runViaWorker } from '../web/agent-worker.js'

// The test suite runs from a git worktree, which workerStartAllowed() treats
// as a second instance and would disable the worker path on. Opt in -- the
// gate targets accidental live-worker takeover, not this fully mocked run.
process.env.MARVEEN_ALLOW_SECOND_INSTANCE_SERVICES = '1'

afterEach(() => {
  for (const p of [tui.state.acceptedOutPath, tui.state.acceptedDonePath]) {
    if (p) { try { rmSync(p, { force: true }) } catch { /* none */ } }
  }
  vi.unstubAllEnvs()
})

// WEB_ONLY=true (a staging instance) disables the worker on purpose; a suite run with it set must not
// paint these fully mocked tests red, so the variable is cleared for each test.
beforeEach(() => { warnLog.length = 0; vi.stubEnv('WEB_ONLY', '') })

describe('agent-worker /clear -> prompt delivery (0038ce9c: pane-state wait, not fixed sleep)', () => {
  it(
    'delivers the prompt only after the TUI has actually processed /clear (slow TUI)',
    { timeout: 30_000 },
    async () => {
      tui.reset()
      const res = await runViaWorker('hello worker', 4000, 'slow')

      // Instrument controls: the fake TUI must have really seen the /clear
      // sequence -- a blind instrument must fail loudly, not pass silently.
      expect(tui.state.clearTextAt, 'instrument: saw the -l /clear keystroke').toBeGreaterThan(0)
      expect(tui.state.enterAt, 'instrument: saw the Enter that submits /clear').toBeGreaterThan(0)
      expect(tui.state.sendKeysCalls.some(c => c.tail.includes('/clear')), 'instrument: /clear went through tmux send-keys').toBe(true)
      expect(tui.state.promptSendAt, 'the run must have attempted the prompt send').not.toBeNull()

      // The contract under test.
      expect(
        tui.state.promptSentWhileBusy,
        'BUG (0038ce9c): the prompt was sent while the pane was still processing /clear',
      ).toBe(false)
      expect(
        tui.state.promptSendAt!,
        'prompt send time must be at/after the pane became ready',
      ).toBeGreaterThanOrEqual(tui.state.readyAt)

      // On the healthy path the fake worker's files close the run as ok.
      expect(res.error).toBeUndefined()
      expect(res.text).toBe('fake worker answer')
      // R2: readiness inside the budget means no exhaustion warning at all.
      expect(warnLog.filter(m => m.includes('did not return an idle prompt'))).toHaveLength(0)
    },
  )

  it(
    'never delivers before the settle floor even when the pane looks idle right after Enter (R1 stale-window corner)',
    { timeout: 30_000 },
    async () => {
      // The stale-window shape: until the TUI reads the queued Enter the pane
      // still shows an idle prompt (modelled here by an instantly-consumed
      // /clear, so the fake is never busy). The delivery decision must still
      // not happen before the old fixed-sleep floor (0.5s) has fully passed.
      tui.reset()
      tui.state.readyDelayMs = 0
      const res = await runViaWorker('floor probe', 4000, 'slow')

      expect(tui.state.enterAt, 'instrument: saw the Enter that submits /clear').toBeGreaterThan(0)
      expect(tui.state.promptSendAt, 'the run must have attempted the prompt send').not.toBeNull()
      expect(
        tui.state.promptSendAt!,
        'R1 corner: prompt sent before the settle floor while the pane only LOOKED idle',
      ).toBeGreaterThanOrEqual(tui.state.enterAt + 500)
      expect(tui.state.promptSentWhileBusy).toBe(false)
      expect(res.error).toBeUndefined()
      expect(res.text).toBe('fake worker answer')
      expect(warnLog.filter(m => m.includes('did not return an idle prompt'))).toHaveLength(0)
    },
  )

  it(
    'fails open past the clear budget: the delivery still goes out and the exhaustion is logged once (A2)',
    { timeout: 30_000 },
    async () => {
      // The TUI needs 10s for /clear, past the 8s wait budget: a dispatch must
      // still deliver (fail open), exactly one exhaustion warning is logged, and
      // the delivery waits out the settle floor + the whole budget first.
      tui.reset()
      tui.state.readyDelayMs = 10_000
      const res = await runViaWorker('fail-open probe', 9_800, 'slow')

      expect(tui.state.promptSendAt, 'fail open: the prompt send must still happen').not.toBeNull()
      expect(
        tui.state.promptSendAt!,
        'fail-open delivery must come after the settle floor + the full budget',
      ).toBeGreaterThanOrEqual(tui.state.enterAt + 500 + 8_000 - 100)
      expect(
        tui.state.promptSentWhileBusy,
        'fail open: delivery into a still-busy pane is the accepted last resort',
      ).toBe(true)
      const exhaustion = warnLog.filter(m => m.includes('did not return an idle prompt'))
      expect(exhaustion).toHaveLength(1)
      // The fake never writes the transport files for a busy-pane delivery, so
      // the run ends in its own timeout error -- never a silent success.
      expect(res.error).toBeTruthy()
    },
  )
})
