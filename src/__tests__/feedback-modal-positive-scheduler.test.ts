// MODALPOSTEST831: the POSITIVE half of the #1123 wiring, schedule-runner leg.
//
// The injector fixtures stub clearFeedbackModalAndRecheck to false, so
// "helper=true -> the scheduler PROCEEDS TO SEND in the same attempt" stood
// only on code reading. This drives a pending retry against a session that is
// present but NOT ready:
//
//   helper=true  -> the modal was the only blocker: the task fires NOW
//                   (sendPromptToSession called, retry row deleted);
//   helper=false -> 'busy' skip as before: no send, the row survives.
//
// The helper-consulted assertion doubles as the earlier-gate regression trap:
// if a future readiness/first-run gate turns the caller back before the
// helper (the exact bug class #1123 fixed), the positive case goes red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

const mockAppendTaskRun = vi.fn()
// Mirrors the real DB: a fired retry's delete removes the row, so the next
// pass of the loop no longer sees it -- without this the fixture re-fires the
// same row on every pass inside the tick window.
let pendingRetries: Array<Record<string, unknown>> = []
const mockDeletePendingRetry = vi.fn((taskName: unknown, _agent?: unknown) => {
  pendingRetries = pendingRetries.filter((r) => r.task_name !== taskName)
})
const mockUpdatePendingRetry = vi.fn(() => true)
const mockListPendingRetries = vi.fn(() => pendingRetries)
const mockSendPrompt = vi.fn(() => 'sent')
const mockSessionExists = vi.fn(() => true)
const mockStartAgent = vi.fn(() => ({ ok: true }))
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
const mockIsReady = vi.fn(() => false)
const mockClearModal = vi.fn(() => false)
let capturePaneCalls = 0

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(a[0], a[1]),
  updatePendingTaskRetry: mockUpdatePendingRetry,
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// Neutralize the real alert sink (would resolve a real bot token from
// install-level config) -- same rule as the sibling scheduler fixtures.
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
  SCHEDULED_TASKS_DIR: '/tmp/marveen-modal-positive-no-tasks-dir',
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: (...a: unknown[]) => mockClearModal(...(a as [])),
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsReady(...(a as [])),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: (...a: unknown[]) => mockStartAgent(...(a as [])),
  sessionExistsOnHost: () => mockSessionExists(),
  // First capture (the not-ready branch's first-run gate check) returns a
  // pane with NO first-run gate on it -- the earlier gate must pass through
  // to the helper, not swallow the modal case. Every later capture (the
  // post-send resubmit loop) returns null so the loop sees nothing parked
  // and stops, same as the sibling fixtures.
  capturePane: (..._a: unknown[]) => (capturePaneCalls++ === 0 ? 'plain pane\n❯ ' : null),
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

function task(overrides: Partial<ScheduledTask> & { name: string; schedule: string }): ScheduledTask {
  return {
    description: 'modal-positive fixture',
    prompt: 'Do the thing.',
    agent: 'modalagent',
    enabled: true,
    createdAt: 0,
    type: 'task',
    targetSession: 'modal-test-session',
    ...overrides,
  }
}

const DAILY = task({ name: 'modal-positive-e2e-daily', schedule: '0 8 * * *' })

function retryRow(overrides: Record<string, unknown> = {}) {
  return {
    task_name: DAILY.name,
    agent_name: 'modalagent',
    first_attempt: Date.now() - 5 * 60000,
    last_attempt: Date.now() - 60000,
    attempt_count: 2,
    last_reason: 'busy',
    alerted_at: null,
    ...overrides,
  }
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

describe('schedule runner: modal cleared on the refusal branch -> the task fires', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Quiet moment (no cron occurrence): only the pending-retry loop acts.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue([DAILY])
    mockSessionExists.mockReturnValue(true)
    mockIsReady.mockResolvedValue(false as never)
    capturePaneCalls = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('helper=true: the retry fires in the SAME attempt and the row drains', async () => {
    mockClearModal.mockResolvedValue(true as never)
    pendingRetries = [retryRow()]
    await runOneTick()

    // The not-ready branch consulted the helper (no earlier gate turned back)
    expect(mockClearModal).toHaveBeenCalled()
    // ...and a cleared modal means the send happens NOW, not on a later retry.
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(DAILY.name, 'modalagent')
  })

  it('negative control, helper=false: busy skip, no send, the row survives', async () => {
    mockClearModal.mockResolvedValue(false as never)
    pendingRetries = [retryRow()]
    await runOneTick()

    expect(mockClearModal).toHaveBeenCalled()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
  })
})
