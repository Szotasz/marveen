import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// SCHEDPARK814. A scheduled task can be deferred forever by a session that is
// not working at all: an interrupted turn can leave a FRAGMENT of an earlier
// prompt parked in the input box, which keeps isSessionReadyForPrompt false, so
// every retry reads 'busy'. Observed 2026-08-14 on a two-hourly mailbox
// heartbeat: 277 consecutive 'busy' retries over 69 minutes, fixed by hand with
// C-c/C-u, then delivered on the next tick.
//
// A pending retry whose target session is MISSING (and whose auto-start fails)
// must survive the tick, not be deleted. Deleting it was a silent abandonment
// that contradicts the never-abandon policy the queue exists for: the one
// real-world window where it bites is a target session vanishing during a
// main-agent restart -- auto-start fails once, and a queued daily task (e.g. a
// morning briefing) is dropped with only a debug log.

const mockAppendTaskRun = vi.fn()
const mockDeletePendingRetry = vi.fn()
// Mirrors the real DB: refreshing the row updates its last_reason, so the
// NEXT tick sees the state this tick wrote (the transition-dedup depends on
// exactly that).
const mockUpdatePendingRetry = vi.fn((taskName: unknown, _agent: unknown, _now: unknown, reason: unknown) => {
  for (const row of mockListPendingRetries() as Array<Record<string, unknown>>) {
    if (row.task_name === taskName) row.last_reason = reason
  }
  return true
})
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSessionExists = vi.fn(() => true)
const mockSessionReady = vi.fn(async () => false)
const mockClearParked = vi.fn(async () => true)
const mockSendPrompt = vi.fn(() => 'sent')
const mockStartAgent = vi.fn(() => ({ ok: false, error: 'tmux unavailable' }))
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The runner persists its last-run map on every fire. Stub the writer so the
// suite never touches the operator's real store.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(...a),
  updatePendingTaskRetry: (...a: unknown[]) => mockUpdatePendingRetry(...(a as [unknown, unknown, unknown, unknown])),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
  upsertBlackboard: vi.fn(() => ({ id: 'bb000001', agent_id: '', task_ref: null, status: 'active', summary: '', updated_at: 0 })),
  findActiveKanbanCardByTitle: vi.fn(() => undefined),
  findBlackboardRowByAgent: vi.fn(() => ({ id: 'bb000001', agent_id: '', task_ref: null, status: 'active', summary: '', updated_at: 0 })),
}))

// The alert paths resolve a REAL bot token from install-level config and send
// to the real owner chat. Neutralize the sink: a green suite must never cost
// the operator's attention.
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-parked-janitor-no-tasks-dir',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => mockSessionReady(),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: (...a: unknown[]) => mockStartAgent(...(a as [])),
  sessionExistsOnHost: () => mockSessionExists(),
  // null capture => no first-run gate is detected, and the post-send resubmit
  // loop sees nothing parked and stops.
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: (...a: unknown[]) => mockClearParked(...(a as [])),
}))

// --- Fixtures for parked-janitor suite ---

const PARKED_TASK: ScheduledTask = {
  name: 'parked-janitor-fixture',
  description: 'parked-input janitor fixture',
  prompt: 'Do the thing.',
  schedule: '0 8 * * *',
  agent: 'parkedagent',
  enabled: true,
  createdAt: 0,
  type: 'heartbeat',
  targetSession: 'parked-test-session',
}

function parkedRetryRow(ageMs: number, overrides: Record<string, unknown> = {}) {
  return {
    task_name: PARKED_TASK.name,
    agent_name: 'parkedagent',
    first_attempt: Date.now() - ageMs,
    last_attempt: Date.now() - 15_000,
    attempt_count: Math.round(ageMs / 15_000),
    last_reason: 'busy',
    alerted_at: null,
    ...overrides,
  }
}

async function runParkedTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(16_000)
  clearInterval(stop)
}

describe('schedule runner: stale-parked-input janitor on the retry queue', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // A quiet moment: no cron occurrence for the fixture, so only the
    // pending-retry loop acts.
    vi.setSystemTime(new Date('2026-08-14T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue([PARKED_TASK])
    mockSessionExists.mockReturnValue(true)
    mockSessionReady.mockResolvedValue(false)
    mockClearParked.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('asks the janitor once a busy retry has waited past the threshold', async () => {
    mockListPendingRetries.mockReturnValue([parkedRetryRow(69 * 60_000)])
    await runParkedTick()

    // Aimed at the session the fire path resolves (targetSession override =>
    // local, host null), not at a re-derived guess.
    expect(mockClearParked).toHaveBeenCalledWith('parked-test-session', null)
    // The row is never dropped by the janitor -- delivery happens on the next
    // tick, through the normal retry path.
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
  })

  it('leaves a young busy retry alone', async () => {
    // Below SCHEDULE_JANITOR_PARKED_MIN_AGE_MS: an ordinary long turn, not a wedge.
    mockListPendingRetries.mockReturnValue([parkedRetryRow(45_000)])
    await runParkedTick()

    expect(mockClearParked).not.toHaveBeenCalled()
  })

  it('does not touch the box for a non-busy verdict', async () => {
    // Session gone + auto-start fails => 'missing'. Old enough to pass the age
    // gate, so only the reason keeps the janitor out.
    mockSessionExists.mockReturnValue(false)
    mockListPendingRetries.mockReturnValue([parkedRetryRow(69 * 60_000)])
    await runParkedTick()

    expect(mockClearParked).not.toHaveBeenCalled()
  })

  it('stays out of the way when the retry simply fires', async () => {
    mockSessionReady.mockResolvedValue(true)
    mockListPendingRetries.mockReturnValue([parkedRetryRow(69 * 60_000)])
    await runParkedTick()

    expect(mockDeletePendingRetry).toHaveBeenCalledWith(PARKED_TASK.name, 'parkedagent')
    expect(mockClearParked).not.toHaveBeenCalled()
  })
})

// --- Fixtures for retry-missing suite ---

function missingTask(overrides: Partial<ScheduledTask> & { name: string; schedule: string }): ScheduledTask {
  return {
    description: 'retry-missing fixture',
    prompt: 'Do the thing.',
    agent: 'retryagent',
    enabled: true,
    createdAt: 0,
    type: 'task',
    targetSession: 'retry-test-session',
    ...overrides,
  }
}

const DAILY = missingTask({ name: 'retry-missing-e2e-daily', schedule: '0 8 * * *' })

function missingRetryRow(overrides: Record<string, unknown> = {}) {
  return {
    task_name: DAILY.name,
    agent_name: 'retryagent',
    first_attempt: Date.now() - 5 * 60000,
    last_attempt: Date.now() - 60000,
    attempt_count: 5,
    last_reason: 'busy',
    alerted_at: null,
    ...overrides,
  }
}

async function runMissingTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  // First tick is scheduled, not immediate: advance past the 60s interval and
  // let the async tick body drain.
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

describe('schedule runner: pending retry survives a missing target session', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // A quiet moment (no cron occurrence for the fixture) so only the
    // pending-retry loop acts.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue([DAILY])
    // The target session is gone and auto-start fails => attemptFireTask
    // resolves 'missing'.
    mockSessionExists.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it("keeps the retry row on 'missing' and logs the transition once across ticks", async () => {
    mockListPendingRetries.mockReturnValue([missingRetryRow()])
    await runMissingTick()

    // The row survives...
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
    // ...its live state is refreshed to 'missing' (feeds the age-based alert)...
    expect(mockUpdatePendingRetry).toHaveBeenCalledWith(DAILY.name, 'retryagent', expect.any(Number), 'missing')
    // ...and the run-log records the TRANSITION exactly once, even though the
    // runner ticked several times inside the window -- a stuck-missing task
    // must not write a run-log row per tick.
    const runs = mockAppendTaskRun.mock.calls.filter(c => c[0] === DAILY.name).map(c => String(c[2]))
    expect(runs).toEqual(['missing-retrying'])
  })

  it('does not re-log a retry already known to be missing', async () => {
    mockListPendingRetries.mockReturnValue([missingRetryRow({ last_reason: 'missing' })])
    await runMissingTick()

    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
    const runs = mockAppendTaskRun.mock.calls.filter(c => c[0] === DAILY.name).map(c => String(c[2]))
    expect(runs).toEqual([])
  })

  it("still deletes the row when the retry finally fires", async () => {
    mockSessionExists.mockReturnValue(true)
    mockListPendingRetries.mockReturnValue([missingRetryRow()])
    await runMissingTick()

    expect(mockDeletePendingRetry).toHaveBeenCalledWith(DAILY.name, 'retryagent')
  })
})
