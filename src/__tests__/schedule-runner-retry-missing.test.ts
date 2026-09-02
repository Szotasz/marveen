import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// A pending retry whose target session is MISSING (and whose auto-start fails)
// must survive the tick, not be deleted. Deleting it was a silent abandonment
// that contradicts the never-abandon policy the queue exists for: the one
// real-world window where it bites is a target session vanishing during a
// main-agent restart -- auto-start fails once, and a queued daily task (e.g. a
// morning briefing) is dropped with only a debug log.
//
// What this pins:
//   * result 'missing' does NOT delete the retry row;
//   * the run-log records the TRANSITION into missing exactly once
//     ('missing-retrying'), not one row per 60s tick;
//   * the row's last_reason is refreshed to 'missing' so the age-based
//     operator alert path keeps working;
//   * result 'fired' still deletes the row (the queue drains normally).

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
const mockSendPrompt = vi.fn(() => 'sent')
const mockSessionExists = vi.fn(() => true)
const mockStartAgent = vi.fn(() => ({ ok: false, error: 'tmux unavailable' }))
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The runner persists its last-run map to store/schedule-last-run.json on every
// fire. Stub the writer so the suite never touches the operator's real store.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(...a),
  updatePendingTaskRetry: mockUpdatePendingRetry,
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// The runner's alert paths resolve a REAL bot token from install-level config
// (HOME-based, so a test worktree does not isolate them) and send to the real
// owner chat. Neutralize the sink entirely: a green suite must never cost the
// operator's attention.
// The runner sends over getProvider(CHANNEL_PROVIDER) since the provider-aware
// alerts (not sendTelegramMessage any more), so THAT is the export to
// neutralize; everything else in channel-provider stays real.
vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: vi.fn(async () => {}),
      sendPhoto: vi.fn(async () => {}),
    }),
  }
})

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-retry-missing-no-tasks-dir',
}))

vi.mock('../web/agent-process.js', () => ({
  // The not-ready-path modal clear: false = no modal, so every caller keeps
  // its existing skip/busy behaviour and these fixtures are unaffected.
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: (...a: unknown[]) => mockStartAgent(...(a as [])),
  sessionExistsOnHost: () => mockSessionExists(),
  // null capture => the post-send resubmit loop sees nothing parked and stops.
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

function task(overrides: Partial<ScheduledTask> & { name: string; schedule: string }): ScheduledTask {
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

const DAILY = task({ name: 'retry-missing-e2e-daily', schedule: '0 8 * * *' })

function retryRow(overrides: Record<string, unknown> = {}) {
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

async function loadRunner() {
  vi.resetModules()
  return await import('../web/schedule-runner.js')
}

async function runOneTick() {
  const { startScheduleRunner } = await loadRunner()
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
    mockListPendingRetries.mockReturnValue([retryRow()])
    await runOneTick()

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
    mockListPendingRetries.mockReturnValue([retryRow({ last_reason: 'missing' })])
    await runOneTick()

    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
    const runs = mockAppendTaskRun.mock.calls.filter(c => c[0] === DAILY.name).map(c => String(c[2]))
    expect(runs).toEqual([])
  })

  it("still deletes the row when the retry finally fires", async () => {
    mockSessionExists.mockReturnValue(true)
    mockListPendingRetries.mockReturnValue([retryRow()])
    await runOneTick()

    expect(mockDeletePendingRetry).toHaveBeenCalledWith(DAILY.name, 'retryagent')
  })
})
