import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// #1954 (part A), the scheduler side: while the main session is respawning in
// process (or settling right after), a tick into it is deferred through the
// existing pending-retry queue, is NOT dropped on skipIfBusy, and fires once
// the hold is over. A tick into any other session is not touched.

const mockAppendTaskRun = vi.fn()
const mockInsertRetry = vi.fn()
const mockDeletePendingRetry = vi.fn()
const mockUpdatePendingRetry = vi.fn(() => true)
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSendPrompt = vi.fn(() => 'sent')
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(...a),
  updatePendingTaskRetry: (...a: unknown[]) => mockUpdatePendingRetry(...(a as [])),
  insertPendingTaskRetryIfNew: (...a: unknown[]) => mockInsertRetry(...a),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// No real owner alert may leave a green suite.
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
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-main-respawn-hold-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

// A quiet minute; the every-minute task falls due on the first tick (+61 s).
const T0 = Date.parse('2026-07-31T10:30:30.000Z')

function task(overrides: Partial<ScheduledTask> & { name: string }): ScheduledTask {
  return {
    description: 'main-respawn-hold fixture',
    prompt: 'Do the thing.',
    schedule: '* * * * *',
    agent: MAIN_AGENT_ID,
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    skipIfBusy: true,
    ...overrides,
  }
}

async function loadModules() {
  vi.resetModules()
  const runner = await import('../web/schedule-runner.js')
  const hold = await import('../web/main-respawn-hold.js')
  return { runner, hold }
}

async function tick(runner: typeof import('../web/schedule-runner.js')) {
  const stop = runner.startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

const sentTo = (): string[] => mockSendPrompt.mock.calls.map((c: unknown[]) => String(c[0]))

describe('schedule-runner: a tick into the main session waits out an in-process respawn', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers({ now: T0 })
    mockListPendingRetries.mockReturnValue([])
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('in flight: the skipIfBusy heartbeat is queued as a retry, not sent and not dropped', async () => {
    mockListScheduledTasks.mockReturnValue([task({ name: 'hold-heartbeat' })])
    const { runner, hold } = await loadModules()
    hold.beginMainRespawn() // the recovery started; no end yet (the 16:40 window)
    await tick(runner)

    expect(sentTo()).not.toContain(MAIN_CHANNELS_SESSION)
    expect(mockInsertRetry).toHaveBeenCalledWith('hold-heartbeat', MAIN_AGENT_ID, expect.any(Number), 'respawning')
    const runs = mockAppendTaskRun.mock.calls.filter((c: unknown[]) => c[0] === 'hold-heartbeat').map((c: unknown[]) => String(c[2]))
    expect(runs).not.toContain('skipped')
  })

  it('settling: a forceSend task is held as well', async () => {
    mockListScheduledTasks.mockReturnValue([task({ name: 'hold-force', type: 'task', skipIfBusy: false, forceSend: true })])
    const { runner, hold } = await loadModules()
    hold.beginMainRespawn()() // started and ended just now: settling
    await tick(runner)

    expect(sentTo()).not.toContain(MAIN_CHANNELS_SESSION)
    expect(mockInsertRetry).toHaveBeenCalledWith('hold-force', MAIN_AGENT_ID, expect.any(Number), 'respawning')
  })

  it('the queued retry fires on the first tick after the settle ends', async () => {
    const daily = task({ name: 'hold-daily', schedule: '0 8 * * *', type: 'task', skipIfBusy: false })
    mockListScheduledTasks.mockReturnValue([daily])
    mockListPendingRetries.mockReturnValue([{
      task_name: 'hold-daily', agent_name: MAIN_AGENT_ID,
      first_attempt: T0 - 60_000, last_attempt: T0 - 30_000, attempt_count: 1,
      last_reason: 'respawning', alerted_at: null,
    }])
    const { runner, hold } = await loadModules()
    const { MAIN_RESPAWN_SETTLE_MS } = hold
    // The respawn ended so that the settle runs out just before the tick: the
    // retry is the one that lands at the end of the hold.
    // The runner's first tick runs at T0 + 60 s (its 60 s interval).
    let clock = T0 + 60_000 - MAIN_RESPAWN_SETTLE_MS - 1
    const end = hold.beginMainRespawn(() => clock)
    end()
    clock = T0 // back to now for the runner's own clock
    await tick(runner)

    expect(sentTo()).toContain(MAIN_CHANNELS_SESSION)
    expect(mockDeletePendingRetry).toHaveBeenCalledWith('hold-daily', MAIN_AGENT_ID)
  })

  it('the same retry stays queued while the settle still runs', async () => {
    const daily = task({ name: 'hold-daily', schedule: '0 8 * * *', type: 'task', skipIfBusy: false })
    mockListScheduledTasks.mockReturnValue([daily])
    mockListPendingRetries.mockReturnValue([{
      task_name: 'hold-daily', agent_name: MAIN_AGENT_ID,
      first_attempt: T0 - 60_000, last_attempt: T0 - 30_000, attempt_count: 1,
      last_reason: 'respawning', alerted_at: null,
    }])
    const { runner, hold } = await loadModules()
    // Ended 30 s before the runner's first tick (T0 + 60 s): still settling.
    hold.beginMainRespawn(() => T0 + 30_000)()
    await tick(runner)

    expect(sentTo()).not.toContain(MAIN_CHANNELS_SESSION)
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
    expect(mockUpdatePendingRetry).toHaveBeenCalledWith('hold-daily', MAIN_AGENT_ID, expect.any(Number), 'respawning')
  })

  it('a sub-agent session is not held by a main-session respawn', async () => {
    mockListScheduledTasks.mockReturnValue([task({ name: 'hold-sub', agent: 'someagent', type: 'task', skipIfBusy: false })])
    const { runner, hold } = await loadModules()
    hold.beginMainRespawn()
    await tick(runner)

    expect(sentTo()).toContain('agent-someagent')
    expect(mockInsertRetry).not.toHaveBeenCalledWith('hold-sub', 'someagent', expect.any(Number), 'respawning')
  })
})
