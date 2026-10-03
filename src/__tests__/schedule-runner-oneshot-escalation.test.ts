import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

// Runner-level wiring for oneShot and busy-deferral escalation (review
// follow-up). The io helpers have their own tests; these pin what the RUNNER
// does with them:
//   * a oneShot task is disabled after its scheduled fire on the cron, retry
//     and command paths -- and a task WITHOUT oneShot never is (a runner that
//     ignored the flag would switch off every scheduled task in a fleet);
//   * escalation happens only when the task sets escalateAfterMinutes, only
//     after that many minutes, never on the main channels session, and when
//     it happens the prompt is sent without waiting for idle.

const mockAppendTaskRun = vi.fn()
let retryRows: Array<Record<string, unknown>> = []
const mockDeletePendingRetry = vi.fn((taskName: unknown, agentName: unknown) => {
  retryRows = retryRows.filter((r) => !(r.task_name === taskName && r.agent_name === agentName))
})
// Mirrors the real DB: refreshing the row updates its last_reason, so the
// NEXT tick sees the state this tick wrote (the transition-dedup depends on
// exactly that).
const mockUpdatePendingRetry = vi.fn((taskName: unknown, _agent: unknown, _now: unknown, reason: unknown) => {
  for (const row of mockListPendingRetries() as Array<Record<string, unknown>>) {
    if (row.task_name === taskName) row.last_reason = reason
  }
  return true
})
const mockListPendingRetries = vi.fn(() => retryRows as unknown[])
const mockSendPrompt = vi.fn((..._a: unknown[]) => 'sent')
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
  // ESCALATEAFTER921: attemptFireTask now looks up the single retry row for
  // (taskName, agentName) before the busy check, mirroring the real
  // getPendingTaskRetry(taskName, agentName) query over the same table
  // listPendingTaskRetries() reads (see db.ts). Derived from the same fixture
  // list so per-test mockListPendingRetries() overrides stay authoritative.
  getPendingTaskRetry: (taskName: unknown, agentName: unknown) =>
    (mockListPendingRetries() as Array<Record<string, unknown>>).find(
      (r) => r.task_name === taskName && r.agent_name === agentName,
    ),
  deletePendingTaskRetry: (taskName: unknown, agentName: unknown) => mockDeletePendingRetry(taskName, agentName),
  updatePendingTaskRetry: mockUpdatePendingRetry,
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markPendingTaskRetryOwnerAlert: vi.fn(() => false),
  clearPendingTaskRetryOwnerAlert: vi.fn(),
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

const mockDisableOneShot = vi.fn((..._a: unknown[]) => true)
const mockRunCommandTask = vi.fn()
const mockReady = vi.fn(() => true)

vi.mock('../web/command-task.js', () => ({
  runCommandTask: (...a: unknown[]) => mockRunCommandTask(...a),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  disableOneShotTask: (...a: unknown[]) => mockDisableOneShot(...a),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-retry-missing-no-tasks-dir',
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
  isSessionReadyForPrompt: () => mockReady(),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
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
    description: 'oneshot/escalation fixture',
    prompt: 'Do the thing.',
    agent: 'retryagent',
    enabled: true,
    createdAt: 0,
    type: 'task',
    targetSession: 'oneshot-test-session',
    ...overrides,
  }
}

function retryRow(t: ScheduledTask, stuckMinutes: number) {
  return {
    task_name: t.name,
    agent_name: t.agent,
    first_attempt: Math.floor((Date.now() - stuckMinutes * 60000) / 1000),
    last_attempt: Math.floor((Date.now() - 60000) / 1000),
    attempt_count: stuckMinutes,
    last_reason: 'busy',
    alerted_at: null,
  }
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

const disabledNames = () => mockDisableOneShot.mock.calls.map((c) => c[0])

describe('schedule runner: oneShot wiring', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockReady.mockReturnValue(true)
    mockSessionExists.mockReturnValue(true)
    retryRows = []
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

  it('cron path: disables a oneShot task after it fires, and leaves a normal task alone', async () => {
    // 07:59:30 Budapest; the tick lands just after 08:00.
    vi.setSystemTime(new Date('2026-07-31T05:59:30.000Z'))
    const once = task({ name: 'oneshot-cron-once', schedule: '0 8 * * *', oneShot: true })
    const daily = task({ name: 'oneshot-cron-daily', schedule: '0 8 * * *', targetSession: 'oneshot-test-session-2' })
    mockListScheduledTasks.mockReturnValue([once, daily])
    await runOneTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(2)
    expect(disabledNames()).toEqual(['oneshot-cron-once'])
  })

  it('retry path: disables a oneShot task when its queued retry fires, and leaves a normal task alone', async () => {
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    const once = task({ name: 'oneshot-retry-once', schedule: '0 8 * * *', oneShot: true })
    const daily = task({ name: 'oneshot-retry-daily', schedule: '0 8 * * *', targetSession: 'oneshot-test-session-2' })
    mockListScheduledTasks.mockReturnValue([once, daily])
    retryRows = [retryRow(once, 5), retryRow(daily, 5)]
    await runOneTick()
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(once.name, once.agent)
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(daily.name, daily.agent)
    expect(disabledNames()).toEqual(['oneshot-retry-once'])
  })

  it('command path: disables a oneShot command task after it runs, and leaves a normal one alone', async () => {
    vi.setSystemTime(new Date('2026-07-31T05:59:30.000Z'))
    const once = task({ name: 'oneshot-cmd-once', schedule: '0 8 * * *', type: 'command', command: 'true', oneShot: true })
    const daily = task({ name: 'oneshot-cmd-daily', schedule: '0 8 * * *', type: 'command', command: 'true' })
    mockListScheduledTasks.mockReturnValue([once, daily])
    await runOneTick()
    expect(mockRunCommandTask).toHaveBeenCalledTimes(2)
    expect(disabledNames()).toEqual(['oneshot-cmd-once'])
  })
})

describe('schedule runner: busy-deferral escalation is opt-in', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    mockSessionExists.mockReturnValue(true)
    // The target session stays busy for the whole test.
    mockReady.mockReturnValue(false)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

  async function tickWithStuckRetry(t: ScheduledTask, stuckMinutes: number) {
    mockListScheduledTasks.mockReturnValue([t])
    retryRows = [retryRow(t, stuckMinutes)]
    await runOneTick()
  }

  it('a task past its escalateAfterMinutes is sent despite the busy session, without waiting for idle', async () => {
    await tickWithStuckRetry(task({ name: 'esc-on', schedule: '0 8 * * *', escalateAfterMinutes: 20 }), 30)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const opts = mockSendPrompt.mock.calls[0]!.find((a) => a && typeof a === 'object' && 'waitForIdle' in (a as object)) as { waitForIdle: boolean }
    expect(opts.waitForIdle).toBe(false)
  })

  it('a task without escalateAfterMinutes keeps deferring, however long it has waited', async () => {
    await tickWithStuckRetry(task({ name: 'esc-unset', schedule: '0 8 * * *' }), 240)
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('a task inside its own escalation window keeps deferring', async () => {
    await tickWithStuckRetry(task({ name: 'esc-window', schedule: '0 8 * * *', escalateAfterMinutes: 60 }), 30)
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('never escalates into the main channels session', async () => {
    await tickWithStuckRetry(task({ name: 'esc-main', schedule: '0 8 * * *', escalateAfterMinutes: 20, targetSession: MAIN_CHANNELS_SESSION }), 240)
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })
})
