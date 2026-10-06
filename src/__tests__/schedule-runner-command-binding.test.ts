import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// SCHEDCMDBIND927: nothing pinned that the scheduler tick actually CALLS
// runCommandTask for a due type='command' task. Measured in the #1580 review:
// removing `runCommandTask(task, now)` from schedule-runner.ts left the whole
// suite green, because every command-task test calls runCommandTask directly.
// This drives the real startScheduleRunner tick with runCommandTask spied, so
// the binding itself is what is asserted.

const mockRunCommandTask = vi.fn()
const mockAppendTaskRun = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
const mockSendPrompt = vi.fn(() => 'sent')

vi.mock('../web/command-task.js', () => ({
  runCommandTask: (...a: unknown[]) => mockRunCommandTask(...a),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The runner persists its last-run map on every fire; never touch the real store.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => [],
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// The runner's alert paths resolve a real bot token and send to the real owner
// chat; neutralize the sink so a green suite never costs the operator anything.
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
  SCHEDULED_TASKS_DIR: '/tmp/marveen-command-binding-no-tasks-dir',
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
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'not in tests' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

function task(overrides: Partial<ScheduledTask> & { name: string; schedule: string }): ScheduledTask {
  return {
    description: 'command-binding fixture',
    prompt: 'echo binding-probe',
    agent: 'bindagent',
    enabled: true,
    createdAt: 0,
    type: 'command',
    ...overrides,
  }
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  // The first tick is scheduled, not immediate: advance past the 60 s interval
  // and let the async tick body drain.
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

describe('schedule runner calls runCommandTask for a due command task (SCHEDCMDBIND927)', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 10:30:00 UTC; the tick runs at 10:31:01, so an every-minute occurrence is due.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('a due command task is handed to runCommandTask, with the task itself', async () => {
    const due = task({ name: 'cmd-binding-due', schedule: '* * * * *' })
    mockListScheduledTasks.mockReturnValue([due])
    await runOneTick()

    expect(mockRunCommandTask).toHaveBeenCalled()
    const call = mockRunCommandTask.mock.calls.find(c => (c[0] as ScheduledTask).name === due.name)
    expect(call, 'runCommandTask was not called with the due command task').toBeDefined()
    expect(typeof call![1]).toBe('number')
    // A command task runs a shell command: no prompt goes to any agent session.
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL: a disabled command task is not run', async () => {
    mockListScheduledTasks.mockReturnValue([task({ name: 'cmd-binding-off', schedule: '* * * * *', enabled: false })])
    await runOneTick()
    expect(mockRunCommandTask).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL: a due ordinary task does not go through runCommandTask', async () => {
    mockListScheduledTasks.mockReturnValue([task({ name: 'plain-task-due', schedule: '* * * * *', type: 'task', targetSession: 'bind-test-session' })])
    await runOneTick()
    expect(mockRunCommandTask).not.toHaveBeenCalled()
  })
})
