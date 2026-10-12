// The recovery brief was wired to ONE restart path: the channel monitor's
// watchdog. Measured on develop @ 3877c61, three other paths also bring an
// agent back on a fresh session and said nothing:
//
//   context-guard-runner.ts   restartAgentProcess(name, { fresh: true })
//   auto-restart-runner.ts    restartAgentProcess(name, { fresh: mode === 'fresh' })
//   routes/agents.ts          the dashboard's own restart/start with fresh
//
// An agent coming back through any of those sat at an empty prompt with its
// uncommitted branch and its in_progress card waiting -- the exact gap card
// 3a64403b describes, through a different door.
//
// The fix moves the decision to the one place all four pass through, so these
// tests pin the RULE rather than the list of callers: a caller added tomorrow
// inherits the behaviour instead of being forgotten.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldBriefAfterStart } from '../web/agent-process.js'
import {
  scheduleRecoveryBrief,
  RECOVERY_BRIEF_DELAY_MS,
  type RecoveryFacts,
} from '../web/restart-recovery-brief.js'

describe('who gets a brief', () => {
  it('briefs a fresh start', () => {
    expect(shouldBriefAfterStart({ fresh: true }, { ok: true })).toBe(true)
  })

  it('says nothing after a --continue resume', () => {
    // The conversation survived, so the agent already knows what it was
    // doing; a brief there repeats what is on its screen.
    expect(shouldBriefAfterStart({ fresh: false }, { ok: true })).toBe(false)
    expect(shouldBriefAfterStart({}, { ok: true })).toBe(false)
  })

  it('says nothing when the start failed', () => {
    // Otherwise the brief is typed into whatever occupies that tmux target
    // next -- and a failed start is exactly when something else might.
    expect(shouldBriefAfterStart({ fresh: true }, { ok: false })).toBe(false)
  })
})

describe('scheduleRecoveryBrief', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const workInFlight = (): RecoveryFacts => ({
    agent: 'devy',
    branch: 'devy/some-task',
    dirty: [{ code: ' M', path: 'src/web/thing.ts' }],
    dirtyTruncated: false,
    inProgress: [{ id: 'abc12345', title: 'Fix the thing' }],
  })

  it('types the brief into the session after the delay, not before', async () => {
    vi.useFakeTimers()
    const sent: { session: string; text: string }[] = []

    scheduleRecoveryBrief(
      'devy',
      'agent-devy',
      async (session, text) => {
        sent.push({ session, text })
        return { ok: true }
      },
      workInFlight,
    )

    // The restart path is still settling modals and the plugin probe here.
    expect(sent).toEqual([])

    await vi.advanceTimersByTimeAsync(RECOVERY_BRIEF_DELAY_MS + 1)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.session).toBe('agent-devy')
    expect(sent[0]!.text).toContain('abc12345')
    expect(sent[0]!.text).toContain('devy/some-task')
  })

  it('stays quiet when the agent had nothing in flight', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => ({ ok: true }))

    scheduleRecoveryBrief('devy', 'agent-devy', send, () => ({
      agent: 'devy',
      branch: 'develop',
      dirty: [],
      dirtyTruncated: false,
      inProgress: [],
    }))
    await vi.advanceTimersByTimeAsync(RECOVERY_BRIEF_DELAY_MS + 1)

    // The scheduler consults the builder rather than sending unconditionally:
    // an idle agent restarted for plugin reasons is never interrupted.
    expect(send).not.toHaveBeenCalled()
  })

  it('never lets a failing sender escape into the restart path', async () => {
    vi.useFakeTimers()
    const boom = vi.fn(async () => {
      throw new Error('tmux target vanished')
    })

    scheduleRecoveryBrief('devy', 'agent-devy', boom, workInFlight)
    // No unhandled rejection, no throw out of the timer: a restart that
    // worked must not be reported as failed because a courtesy message could
    // not be typed.
    await vi.advanceTimersByTimeAsync(RECOVERY_BRIEF_DELAY_MS + 1)

    expect(boom).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The wiring itself
// ---------------------------------------------------------------------------
//
// The tests above pass with the brief wired to NOTHING -- a mutation proved
// it: deleting the call from startAgentProcess left all six green. That is the
// same failure the card describes one level up (a module that exists and is
// never reached), so the door is asserted here, at the source, the way
// send-prompt-force-send-gate.test.ts asserts its own gate.

describe('the brief is scheduled where fresh sessions are created', () => {
  const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

  it('startAgentProcess schedules it, so every fresh caller inherits it', () => {
    const start = AGENT_PROCESS.indexOf('export async function startAgentProcess(')
    expect(start).toBeGreaterThan(0)
    const body = AGENT_PROCESS.slice(start)
    const call = body.indexOf('scheduleRecoveryBrief(')
    expect(call, 'startAgentProcess no longer schedules the recovery brief').toBeGreaterThan(0)
    // Gated, not unconditional: the predicate is what keeps a --continue
    // resume and a failed start quiet.
    expect(body.slice(0, call)).toContain('shouldBriefAfterStart(')
  })

  it('no restart path schedules it a second time', () => {
    // It used to live at the channel monitor's call site. Leaving that behind
    // after moving it here would type the brief twice on that one path.
    const monitor = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
    expect(monitor).not.toContain('scheduleRecoveryBrief(')
  })
})
