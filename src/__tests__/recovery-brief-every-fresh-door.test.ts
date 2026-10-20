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
import { scheduleRecoveryBrief, cancelRecoveryBrief, type RecoveryFacts } from '../web/restart-recovery-brief.js'
import { RESUME_DELIVERY_OPTIONS } from '../web/resume-delivery.js'

describe('who gets a brief', () => {
  it('briefs a fresh start', () => {
    expect(shouldBriefAfterStart({ fresh: true }, { ok: true })).toBe(true)
  })

  it('briefs a --continue start too (the reconcile and API doors)', () => {
    // The --continue session remembers the conversation but
    // nobody hands it a new turn. 32 of 41 such restarts (7 days) were followed
    // by an idle agent. The brief's own rule (no facts, no message) keeps a
    // genuinely idle agent quiet.
    expect(shouldBriefAfterStart({ fresh: false }, { ok: true })).toBe(true)
    expect(shouldBriefAfterStart({}, { ok: true })).toBe(true)
  })

  it('stays out when the caller delivers its own first prompt (context guard)', () => {
    // Two prompts for one restart was measured in 10 cases.
    expect(shouldBriefAfterStart({ fresh: true, ownsResume: true }, { ok: true })).toBe(false)
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

  const delivery = (ready: () => boolean, sent: { session: string; text: string }[]) => ({
    isReady: async () => ready(),
    send: async (session: string, text: string) => {
      sent.push({ session, text })
      return 'sent' as const
    },
  })

  it('types the brief into the session at the first check, not before', async () => {
    vi.useFakeTimers()
    const sent: { session: string; text: string }[] = []

    scheduleRecoveryBrief('devy', 'agent-devy', delivery(() => true, sent), workInFlight)

    // The restart path is still settling modals and the plugin probe here.
    await vi.advanceTimersByTimeAsync(RESUME_DELIVERY_OPTIONS.firstMs - 1)
    expect(sent).toEqual([])

    await vi.advanceTimersByTimeAsync(2)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.session).toBe('agent-devy')
    expect(sent[0]!.text).toContain('abc12345')
    expect(sent[0]!.text).toContain('devy/some-task')
  })

  it('does not type into a pane that is not ready, and does once it is', async () => {
    vi.useFakeTimers()
    const sent: { session: string; text: string }[] = []
    let ready = false

    scheduleRecoveryBrief('devy', 'agent-devy', delivery(() => ready, sent), workInFlight)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(sent).toEqual([])

    ready = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent).toHaveLength(1)
  })

  it('stays quiet when the agent had nothing in flight', async () => {
    vi.useFakeTimers()
    const sent: { session: string; text: string }[] = []

    scheduleRecoveryBrief('devy', 'agent-devy', delivery(() => true, sent), () => ({
      agent: 'devy',
      branch: 'develop',
      dirty: [],
      dirtyTruncated: false,
      inProgress: [],
    }))
    await vi.advanceTimersByTimeAsync(RESUME_DELIVERY_OPTIONS.firstMs + 1)

    // The scheduler consults the builder rather than sending unconditionally:
    // an idle agent restarted for plugin reasons is never interrupted.
    expect(sent).toEqual([])
  })

  it('two starts of the same agent yield exactly ONE brief (the newest owns it)', async () => {
    // --continue start, then verifyContinueLaunch falls back to a fresh start;
    // or a double restart, or a crash-loop reconcile start. Each success
    // schedules a loop, and all of them target the same session name.
    vi.useFakeTimers()
    const sent: { session: string; text: string }[] = []
    scheduleRecoveryBrief('devy', 'agent-devy', delivery(() => true, sent), workInFlight)
    await vi.advanceTimersByTimeAsync(5_000)
    scheduleRecoveryBrief('devy', 'agent-devy', delivery(() => true, sent), workInFlight)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sent).toHaveLength(1)
  })

  it('a stop cancels a waiting brief, so a later start is not briefed twice', async () => {
    vi.useFakeTimers()
    const sent: { session: string; text: string }[] = []
    scheduleRecoveryBrief('devy', 'agent-devy', delivery(() => true, sent), workInFlight)
    await vi.advanceTimersByTimeAsync(5_000)
    cancelRecoveryBrief('devy') // stopAgentProcess
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sent).toEqual([])
  })

  it('different agents do not cancel each other', async () => {
    vi.useFakeTimers()
    const sent: { session: string; text: string }[] = []
    scheduleRecoveryBrief('devy', 'agent-devy', delivery(() => true, sent), workInFlight)
    scheduleRecoveryBrief('boni', 'agent-boni', delivery(() => true, sent), () => ({ ...workInFlight(), agent: 'boni' }))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sent.map((x) => x.session).sort()).toEqual(['agent-boni', 'agent-devy'])
  })

  it('never lets a failing sender escape into the restart path', async () => {
    vi.useFakeTimers()
    const boom = vi.fn(async () => {
      throw new Error('tmux target vanished')
    })

    scheduleRecoveryBrief('devy', 'agent-devy', { isReady: async () => true, send: boom }, workInFlight)
    // No unhandled rejection, no throw out of the timer: a restart that
    // worked must not be reported as failed because a courtesy message could
    // not be typed. And no second try: part of the text may have landed.
    await vi.advanceTimersByTimeAsync(5 * 60_000)

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
    // Gated, not unconditional: the predicate is what keeps a failed start and
    // a caller that owns its resume quiet.
    expect(body.slice(0, call)).toContain('shouldBriefAfterStart(')
  })

  it('the brief is typed only through the readiness gate and an aborting send', () => {
    const start = AGENT_PROCESS.indexOf('export async function startAgentProcess(')
    const body = AGENT_PROCESS.slice(start)
    const call = body.indexOf('scheduleRecoveryBrief(')
    const wiring = body.slice(call, call + 700)
    expect(wiring).toContain('isSessionReadyForPrompt(')
    expect(wiring).toContain("onBusyTimeout: 'abort'")
  })

  it('the reconcile door reaches it through startAgentProcess, with no opt-out', () => {
    // The channel monitor's reconcile/watchdog start has no `fresh`, no
    // `ownsResume` and no wake: it inherits the brief.
    const monitor = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
    expect(monitor).toMatch(/startAgentProcess\(name\)/)
    expect(monitor).not.toContain('ownsResume')
  })

  it('a restart that owes a RESTART-WAKE opts out INSIDE restartAgentProcess: the wake is its one first prompt', () => {
    // The API route asks for a wake on every --continue restart
    // (restartOptsFromBody), as do the plan switches and the model fallback.
    // Those doors get the wake, not the brief -- one restart, one first
    // prompt. A fresh API restart, or a body with {"wake": false}, owes no
    // wake and keeps the brief.
    const routes = readFileSync(join(__dirname, '../web/routes/agents.ts'), 'utf-8')
    expect(routes).toContain('restartAgentProcess(name, restartOptsFromBody(restartBody))')
    expect(routes).not.toContain('ownsResume')
    const restart = AGENT_PROCESS.slice(AGENT_PROCESS.indexOf('export async function restartAgentProcess('))
    const body = restart.slice(0, restart.indexOf('\n}\n'))
    expect(body).toContain('const willWake = !opts.fresh && !!opts.wake')
    expect(body).toContain('startAgentProcess(name, willWake ? { ...opts, ownsResume: true } : opts)')
  })

  it('besides the wake-owing restarts, only the context guard and the scheduler auto-start opt out: both deliver their own first prompt', () => {
    const guard = readFileSync(join(__dirname, '../web/context-guard-runner.ts'), 'utf-8')
    expect(guard).toContain('restartAgentProcess(name, { fresh: true, ownsResume: true })')
    // The scheduler starts a missing agent to deliver the scheduled prompt on
    // its retry; a brief in front of it would be a second first prompt.
    const scheduler = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(scheduler).toContain('startAgentProcess(agentName, { ownsResume: true })')
    // no other source file asks for ownsResume
    const users = ['channel-monitor.ts', 'routes/agents.ts', 'auto-restart-runner.ts', 'model-fallback-runner.ts', 'routes/claude-plans.ts', 'claude-plan-fleet-wiring.ts']
      .filter((f) => readFileSync(join(__dirname, '../web', f), 'utf-8').includes('ownsResume'))
    expect(users).toEqual([])
  })

  it('stopAgentProcess cancels the waiting brief', () => {
    const start = AGENT_PROCESS.indexOf('export async function stopAgentProcess(')
    expect(start).toBeGreaterThan(0)
    expect(AGENT_PROCESS.slice(start, start + 400)).toContain('cancelRecoveryBrief(name)')
  })

  it('no restart path schedules it a second time', () => {
    // It used to live at the channel monitor's call site. Leaving that behind
    // after moving it here would type the brief twice on that one path.
    const monitor = readFileSync(join(__dirname, '../web/channel-monitor.ts'), 'utf-8')
    expect(monitor).not.toContain('scheduleRecoveryBrief(')
  })
})
