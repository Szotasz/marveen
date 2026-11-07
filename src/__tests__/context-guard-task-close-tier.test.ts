// The context-guard's TASK-CLOSE tier (CTXGUARDTIERS1107).
//
// Edge-triggered: fires once when the agent's kanban queue (in_progress /
// waiting cards) goes from non-empty to empty, never on every sweep that finds
// it empty, never while another card is still open, and never while an inbound
// message is still waiting (owner question, unanswered owner message, pending
// inter-agent row). Opt-in, default OFF.
import { describe, it, expect } from 'vitest'
import {
  decideGuard,
  normalizeContextGuardConfig,
  taskCloseStep,
  taskCloseSweep,
  taskCloseSkipSweep,
  applyTaskCloseSkipSweep,
  contextGuardWeakenings,
  TASK_CLOSE_REASON_PREFIX,
  PERIODIC_HANDOFF_REASON_PREFIX,
  IDLE_FLUSH_REASON_PREFIX,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  type ContextGuardConfig,
  type GuardInputs,
} from '../context-guard.js'
import { taskCloseHandoffPrompt } from '../web/context-guard-runner.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const runnerSrc = (): string => readFileSync(join(ROOT, 'src/web/context-guard-runner.ts'), 'utf-8')

const NOW = 1_790_000_000_000
const MIN = 60_000

const TASK_CLOSE_ONLY: ContextGuardConfig = {
  ...DEFAULT_CONTEXT_GUARD,
  enabled: false,
  saturationRestart: false,
  idleFlushEnabled: false,
  dailyHandoffEnabled: false,
  taskCloseHandoffEnabled: true,
}

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: true,
    paneBusy: false,
    paneBackgroundWork: false,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    contextTokens: null,
    idleMs: null,
    dailyHandoffDue: false,
    periodicHandoffDue: false,
    taskCloseHandoffDue: false,
    usageLimited: false,
    pendingResumeExpiresAtMs: null,
    ...overrides,
  }
}

/** Drive applyTaskCloseSkipSweep over a sequence of (open?, inbound?) sweeps;
 *  the runner's serve-commit (disarm on a fired handoff) is applied when due. */
function drive(cfg: ContextGuardConfig, sweeps: Array<{ open: boolean; inbound?: boolean }>): boolean[] {
  const armed = new Map<string, boolean>()
  return sweeps.map(({ open, inbound }) => {
    const due = applyTaskCloseSkipSweep(armed, 'a', cfg, open, true, () => inbound === true)
    if (due) armed.set('a', false) // the runner disarms once the decision fires
    return due
  })
}

describe('config -- default off', () => {
  it('ships disabled; only literal true arms it', () => {
    expect(DEFAULT_CONTEXT_GUARD.taskCloseHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({}).taskCloseHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ taskCloseHandoffEnabled: 'yes' }).taskCloseHandoffEnabled).toBe(false)
    expect(normalizeContextGuardConfig({ taskCloseHandoffEnabled: true }).taskCloseHandoffEnabled).toBe(true)
  })

  it('switching it off counts as weakening', () => {
    const on = normalizeContextGuardConfig({ taskCloseHandoffEnabled: true })
    expect(contextGuardWeakenings(on, { ...on, taskCloseHandoffEnabled: false })).toContain('taskCloseHandoffEnabled')
  })

  it('a disabled tier never fires, whatever the board does', () => {
    expect(drive(DEFAULT_CONTEXT_GUARD, [{ open: true }, { open: false }, { open: false }])).toEqual([false, false, false])
  })
})

describe('taskCloseStep -- the edge', () => {
  it('first sight of an empty board does not fire', () => {
    expect(taskCloseStep(undefined, false)).toEqual({ due: false, armed: false })
  })

  it('arms on an open card, fires on the non-empty -> empty edge', () => {
    expect(taskCloseStep(undefined, true)).toEqual({ due: false, armed: true })
    expect(taskCloseStep(true, false)).toEqual({ due: true, armed: true })
  })

  it('ineligible sweeps keep the arming without firing', () => {
    expect(taskCloseSweep(TASK_CLOSE_ONLY, true, false, false)).toEqual({ due: false, armed: true })
  })
})

describe('task-close edge over sweeps', () => {
  it('fires ONCE on the edge, not on every empty sweep after it', () => {
    expect(drive(TASK_CLOSE_ONLY, [{ open: true }, { open: false }, { open: false }, { open: false }])).toEqual([false, true, false, false])
  })

  it('does not fire while another card is still open (one of two closes)', () => {
    // Two cards open -> one closes (count still >0) -> board stays non-empty.
    expect(drive(TASK_CLOSE_ONLY, [{ open: true }, { open: true }, { open: true }])).toEqual([false, false, false])
  })

  it('fires again on the NEXT edge after new work opened and drained', () => {
    expect(drive(TASK_CLOSE_ONLY, [{ open: true }, { open: false }, { open: true }, { open: false }])).toEqual([false, true, false, true])
  })

  it('an unanswered inbound blocks the edge; it stays armed and fires once the inbound clears', () => {
    expect(drive(TASK_CLOSE_ONLY, [
      { open: true },
      { open: false, inbound: true },
      { open: false, inbound: true },
      { open: false, inbound: false },
      { open: false, inbound: false },
    ])).toEqual([false, false, false, true, false])
  })

  it('the inbound check is read only on a due sweep', () => {
    let reads = 0
    taskCloseSkipSweep(TASK_CLOSE_ONLY, true, true, true, () => { reads++; return true })
    taskCloseSkipSweep(TASK_CLOSE_ONLY, false, false, true, () => { reads++; return true })
    expect(reads).toBe(0)
    taskCloseSkipSweep(TASK_CLOSE_ONLY, true, false, true, () => { reads++; return true })
    expect(reads).toBe(1)
  })

  it('a higher tier winning the sweep without a handoff leaves the edge armed (not lost)', () => {
    const armed = new Map<string, boolean>([['a', true]])
    expect(applyTaskCloseSkipSweep(armed, 'a', TASK_CLOSE_ONLY, false, true, () => false)).toBe(true)
    // runner did NOT commit (decision was something else) -> still due next sweep
    expect(applyTaskCloseSkipSweep(armed, 'a', TASK_CLOSE_ONLY, false, true, () => false)).toBe(true)
  })
})

describe('decideGuard -- the task-close tier', () => {
  it('default config: a due flag does nothing', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ taskCloseHandoffDue: true }), DEFAULT_CONTEXT_GUARD)
    expect(d.reason.startsWith(TASK_CLOSE_REASON_PREFIX)).toBe(false)
  })

  it('fires when due, as the only armed tier', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ taskCloseHandoffDue: true }), TASK_CLOSE_ONLY)
    expect(d.action).toBe('request-handoff')
    expect(d.reason.startsWith(TASK_CLOSE_REASON_PREFIX)).toBe(true)
    expect(d.nextState.phase).toBe('await-handoff')
    expect(d.nextState.deadlineMs).toBe(NOW + TASK_CLOSE_ONLY.handoffTimeoutMinutes * MIN)
  })

  it('a busy pane blocks it', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ taskCloseHandoffDue: true, paneIdle: false, paneBusy: true }), TASK_CLOSE_ONLY)
    expect(d.action).toBe('none')
  })

  it('only one tier per sweep: task-close outranks periodic; idle-flush outranks task-close', () => {
    const both = { ...TASK_CLOSE_ONLY, periodicHandoffEnabled: true }
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ taskCloseHandoffDue: true, periodicHandoffDue: true }), both)
    expect(d.reason.startsWith(TASK_CLOSE_REASON_PREFIX)).toBe(true)
    expect(d.reason.startsWith(PERIODIC_HANDOFF_REASON_PREFIX)).toBe(false)
    const flush = { ...both, idleFlushEnabled: true }
    const f = decideGuard(INITIAL_GUARD_STATE, inputs({ taskCloseHandoffDue: true, periodicHandoffDue: true, contextTokens: 500_000, idleMs: 30 * MIN }), flush)
    expect(f.reason.startsWith(IDLE_FLUSH_REASON_PREFIX)).toBe(true)
  })

  it('the saturation net and a usage limit outrank it', () => {
    const cfg = { ...TASK_CLOSE_ONLY, saturationRestart: true }
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ taskCloseHandoffDue: true, paneSaturated: true }), cfg).reason.startsWith(TASK_CLOSE_REASON_PREFIX)).toBe(false)
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ taskCloseHandoffDue: true, usageLimited: true }), TASK_CLOSE_ONLY).action).toBe('none')
  })
})

describe('runner wiring', () => {
  it('the prompt says the queue drained and claims no percentage', () => {
    const p = taskCloseHandoffPrompt('/x/HANDOFF.md')
    expect(p).toContain('kanban')
    expect(p).toContain('/x/HANDOFF.md')
    expect(p).not.toMatch(/\d+%/)
    expect(p).not.toContain('—')
  })

  it('the inbound check covers the owner hold, the raw unanswered inbound and pending inter-agent rows, fail-closed', () => {
    const code = runnerSrc()
    expect(code).toContain(
      'function taskCloseInboundOpen(name: string): boolean {\n' +
      '  try {\n' +
      '    if (ownerQuestionHolds(name)) return true\n' +
      '    if (hasOpenInboundQuestion(name)) return true\n' +
      '    return countRestartQueueState(name, 0).pending > 0\n' +
      '  } catch { return true }\n' +
      '}\n',
    )
  })

  it('an unreadable board counts as still open (never fires on a DB hiccup)', () => {
    expect(runnerSrc()).toContain('return n === null || n > 0')
  })

  it('any handoff/restart decision disarms the edge (no back-to-back cycle)', () => {
    expect(runnerSrc()).toMatch(/if \(decision\.action === 'request-handoff' \|\| decision\.action === 'restart'\) \{[\s\S]*?taskCloseArmed\.set\(name, false\)/)
  })

  it('the disarm runs only after the restart deferrals, so a deferred cycle keeps the edge armed', () => {
    const code = runnerSrc()
    const commit = code.indexOf('    taskCloseArmed.set(name, false)\n')
    expect(commit).toBeGreaterThan(code.indexOf('const gate = await heavyJobGate('))
    expect(commit).toBeGreaterThan(code.indexOf('if (shouldDeferForRecentRespawn(lastRespawn, nowMs)) {'))
    expect(commit).toBeLessThan(code.indexOf('  guardStates.set(name, decision.nextState)\n'))
  })

  it('the runner picks the task-close prompt by its reason prefix', () => {
    expect(runnerSrc()).toContain('promptReason.startsWith(TASK_CLOSE_REASON_PREFIX)')
  })
})
