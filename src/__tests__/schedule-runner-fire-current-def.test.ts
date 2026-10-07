import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// SCHEDRECHECK1007 (a #1749 review follow-up): a tick reads the task list ONCE,
// and every await inside it -- here: the fire of the task before -- lets the
// operator change a task that is still waiting its turn in the same tick. The
// cron branch used to fire that waiting task from the tick's snapshot: a task
// disabled meanwhile still fired, and an edited prompt went out in its old form.
//
// Driven through the real tick: two every-minute tasks due in the same tick,
// and the first task's fire (the sendPromptToSession mock) changes the second
// one on "disk" (the listScheduledTasks mock) before the second one's turn.
//   * second task disabled during the first fire -> it does not fire;
//   * second task deleted during the first fire  -> it does not fire;
//   * second task's prompt edited                -> the EDITED prompt goes out;
//   * control: nothing changes                   -> both fire, as written.

const mockAppendTaskRun = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
const sentPrompts: Array<{ session: string; prompt: string }> = []
// What the first fire does to the task list, before the second task's turn.
let duringFirstFire: () => void = () => {}

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
  getPendingTaskRetry: () => undefined,
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// The runner's alert paths would resolve a REAL bot token; neutralize the sink.
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
  SCHEDULED_TASKS_DIR: '/tmp/marveen-fire-current-def-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: async (session: string, prompt: string) => {
    const first = sentPrompts.length === 0
    sentPrompts.push({ session, prompt })
    if (first) duringFirstFire()
    return 'sent'
  },
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'not in tests' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

function task(overrides: Partial<ScheduledTask> & { name: string }): ScheduledTask {
  return {
    description: 'fire-current-def fixture',
    prompt: 'Do the thing.',
    schedule: '* * * * *',
    agent: 'curagent',
    enabled: true,
    createdAt: 0,
    type: 'task',
    ...overrides,
  }
}

const FIRST = task({ name: 'aa-first-task', prompt: 'FIRST task prompt', targetSession: 'first-session' })
const SECOND = task({ name: 'bb-second-task', prompt: 'SECOND task prompt, original', targetSession: 'second-session' })

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  // Only the startup tick (+5 s): a second tick would fire both tasks again
  // and blur which tick saw which state.
  await vi.advanceTimersByTimeAsync(6_000)
  clearInterval(stop)
}

const sentTo = (session: string) => sentPrompts.filter(p => p.session === session)

describe('schedule runner: a cron fire uses the task as it is now, not the tick snapshot', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 10:30:00 UTC; the startup tick runs at 10:30:05, an every-minute occurrence is due.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    sentPrompts.length = 0
    duringFirstFire = () => {}
    mockListScheduledTasks.mockReturnValue([FIRST, SECOND])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('control: nothing changes -> both tasks fire, each with its own prompt', async () => {
    await runOneTick()
    expect(sentTo('first-session')).toHaveLength(1)
    expect(sentTo('second-session')).toHaveLength(1)
    expect(sentTo('second-session')[0].prompt).toContain('SECOND task prompt, original')
  })

  it('the second task is disabled while the first one fires -> it does not fire', async () => {
    duringFirstFire = () => { mockListScheduledTasks.mockReturnValue([FIRST, { ...SECOND, enabled: false }]) }
    await runOneTick()
    expect(sentTo('first-session')).toHaveLength(1)
    expect(sentTo('second-session')).toHaveLength(0)
  })

  it('the second task is deleted while the first one fires -> it does not fire', async () => {
    duringFirstFire = () => { mockListScheduledTasks.mockReturnValue([FIRST]) }
    await runOneTick()
    expect(sentTo('first-session')).toHaveLength(1)
    expect(sentTo('second-session')).toHaveLength(0)
  })

  it('the second task\'s prompt is edited while the first one fires -> the EDITED prompt goes out', async () => {
    duringFirstFire = () => {
      mockListScheduledTasks.mockReturnValue([FIRST, { ...SECOND, prompt: 'SECOND task prompt, EDITED' }])
    }
    await runOneTick()
    const second = sentTo('second-session')
    expect(second).toHaveLength(1)
    expect(second[0].prompt).toContain('SECOND task prompt, EDITED')
    expect(second[0].prompt).not.toContain('SECOND task prompt, original')
  })
})
