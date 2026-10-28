import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// A task the registry gate skips is still ON DISK.
// The skip can be transient -- update.sh rewrites a task's files a moment
// before it re-registers them, a registry read can fail once -- so the pending
// retry of such a task must survive the tick. It used to be deleted like the
// retry of a task that no longer exists, and the queued occurrence was lost.
//
// What this pins:
//   * gate-skipped + still on disk -> the retry row is kept, nothing fires;
//   * really gone from disk -> the row is still deleted (control);
//   * once the gate passes again, the kept retry fires and drains.

const gateSkips = vi.hoisted(() => new Set<string>())
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
  getPendingTaskRetry: () => undefined,
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

// Scheduled-task registry: this suite drives the runner with fixture tasks that never went
// through the dashboard API; the registry gate is covered by
// schedule-source-registry.test.ts, so here it is a passthrough.
vi.mock('../web/schedule-registry.js', () => ({
  // The gate under test: every task named in gateSkips is refused.
  filterRegisteredTasks: <T extends { name: string }>(tasks: T[]) => tasks.filter(t => !gateSkips.has(t.name)),
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-retry-gateskip-no-tasks-dir',
  // SCHEDPROMPTREF917: attemptFireTask reads these on every fire (size-guard
  // + inline/snapshot threshold). Real values -- the fixtures' short prompts
  // must stay well under them so the size-guard/snapshot path never trips.
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
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
    description: 'retry-gate-skip fixture',
    prompt: 'Do the thing.',
    agent: 'retryagent',
    enabled: true,
    createdAt: 0,
    type: 'task',
    targetSession: 'retry-test-session',
    ...overrides,
  }
}

const DAILY = task({ name: 'retry-gateskip-e2e-daily', schedule: '0 8 * * *' })

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

describe('schedule runner: a gate-skipped task keeps its pending retry', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    gateSkips.clear()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue([DAILY])
    mockSessionExists.mockReturnValue(true)
    mockListPendingRetries.mockReturnValue([retryRow()])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('keeps the retry row while the task is on disk but refused by the gate', async () => {
    gateSkips.add(DAILY.name)
    await runOneTick()
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('still deletes the row of a task that is gone from disk (control)', async () => {
    mockListScheduledTasks.mockReturnValue([])
    await runOneTick()
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(DAILY.name, 'retryagent')
  })

  it('fires and drains the kept retry once the gate passes again', async () => {
    gateSkips.add(DAILY.name)
    await runOneTick()
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
    gateSkips.clear()
    await runOneTick()
    expect(mockSendPrompt).toHaveBeenCalled()
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(DAILY.name, 'retryagent')
  })

  // The kept retry must not outlive the operator's
  // disable. A gate-skipped task that is also disabled drops its retry, so
  // re-registering and enabling it later does not fire the stale occurrence.
  it('drops the retry of a gate-skipped task that is disabled on disk, so a later enable does not fire it', async () => {
    const rows = [retryRow()]
    mockListPendingRetries.mockImplementation(() => rows)
    mockDeletePendingRetry.mockImplementation((name: unknown) => {
      const i = rows.findIndex(r => r.task_name === name)
      if (i >= 0) rows.splice(i, 1)
    })
    try {
      gateSkips.add(DAILY.name)
      mockListScheduledTasks.mockReturnValue([{ ...DAILY, enabled: false }])
      await runOneTick()
      expect(mockDeletePendingRetry).toHaveBeenCalledWith(DAILY.name, 'retryagent')
      expect(mockSendPrompt).not.toHaveBeenCalled()

      gateSkips.clear()                            // re-registered
      mockListScheduledTasks.mockReturnValue([DAILY]) // and enabled again
      await runOneTick()
      expect(mockSendPrompt).not.toHaveBeenCalled()
    } finally {
      mockDeletePendingRetry.mockImplementation(() => undefined)
    }
  })
})
