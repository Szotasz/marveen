import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// Scheduled tasks reach a worksource agent through its queue, not the keyboard.
// Driven through the REAL tick (same harness as
// schedule-runner-fire-current-def.test.ts): one every-minute task targeting a
// sub-agent, with the agent's worksourceChannel flag flipped per test.
//   * flag on  -> enqueueWorksourceItem gets the fire, sendPromptToSession does not;
//   * flag off -> the typed path, exactly as before;
//   * the queued content is byte for byte the prompt the typed path would type;
//   * an enqueue that reports "already present" records no run and types nothing.

const mockAppendTaskRun = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
// Default: the folder of a task is named after it (the normal case).
const mockReadScheduledTask = vi.fn((n: string): ScheduledTask | null => mockListScheduledTasks().find(t => t.name === n) ?? null)
const sentPrompts: Array<{ session: string; prompt: string }> = []
const mockEnqueue = vi.fn((..._args: unknown[]): boolean => true)
// The agent's worksourceChannel opt-in, flipped per test through the mock below.
let worksourceFlag = false

// Scheduled-task registry: the runner fires only registry-matched tasks; here it
// is a passthrough (the gate is covered by schedule-source-registry.test.ts).
vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
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
  readScheduledTask: (n: string) => mockReadScheduledTask(n),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-worksource-fire-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))

// The worksource opt-in is the one knob this file exists to flip; everything
// else in agent-config stays real (readAgentRemoteHost on a nonexistent agent
// dir yields host=null, which is what a local worksource agent looks like).
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    readAgentWorksourceChannel: () => worksourceFlag,
  }
})

vi.mock('../web/worksource-queue.js', () => ({
  enqueueWorksourceItem: (...a: unknown[]) => mockEnqueue(...a),
  worksourceRootFor: (agent: string) => `/tmp/marveen-worksource-test-${agent}`,
  worksourceItemId: (id: number | string) => `msg-${String(id).replace(/[^A-Za-z0-9._-]/g, '')}`,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: async (session: string, prompt: string) => {
    sentPrompts.push({ session, prompt })
    return 'sent'
  },
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'not in tests' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

const TASK_NAME = 'ws-task'
const AGENT = 'wsagent'

function task(overrides: Partial<ScheduledTask> & { name: string }): ScheduledTask {
  return {
    description: 'worksource fire fixture',
    prompt: 'Do the worksource thing.',
    schedule: '* * * * *',
    agent: AGENT,
    enabled: true,
    createdAt: 0,
    type: 'task',
    ...overrides,
  }
}

const TASK = task({ name: TASK_NAME, prompt: 'WS task prompt', targetSession: 'ws-session' })

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  // Only the startup tick (+5 s): a second tick would fire the task again.
  await vi.advanceTimersByTimeAsync(6_000)
  clearInterval(stop)
}

const runsForTask = () => mockAppendTaskRun.mock.calls.filter(c => c[0] === TASK_NAME)

describe('schedule runner: a worksource agent gets scheduled prompts through its queue', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 10:30:00 UTC; the startup tick runs at 10:30:05, an every-minute occurrence is due.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    sentPrompts.length = 0
    worksourceFlag = false
    mockListScheduledTasks.mockReturnValue([TASK])
    mockReadScheduledTask.mockImplementation((n: string) => mockListScheduledTasks().find(t => t.name === n) ?? null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('flag on: queued with a sched- id and scheduler meta; nothing typed; run recorded as fired', async () => {
    worksourceFlag = true
    await runOneTick()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const [agent, itemId, prompt, meta] = mockEnqueue.mock.calls[0]
    expect(agent).toBe(AGENT)
    expect(String(itemId)).toMatch(/^sched-/)
    expect(String(prompt)).toContain('WS task prompt')
    expect((meta as Record<string, string>).from).toBe('scheduler')
    expect(sentPrompts).toHaveLength(0)
    expect(runsForTask()).toContainEqual([TASK_NAME, AGENT, 'fired'])
  })

  it('the queued content is byte for byte the prompt the typed path would type', async () => {
    worksourceFlag = false
    await runOneTick()
    expect(sentPrompts).toHaveLength(1)
    const typedPrompt = sentPrompts[0].prompt

    worksourceFlag = true
    sentPrompts.length = 0
    mockEnqueue.mockClear()
    await runOneTick()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const queuedPrompt = mockEnqueue.mock.calls[0][2]
    expect(queuedPrompt).toBe(typedPrompt)
  })

  it('flag off: the typed path, and the queue is not touched', async () => {
    worksourceFlag = false
    await runOneTick()
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0].session).toBe('ws-session')
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('enqueue reports the item already present: no run row is opened and nothing is typed', async () => {
    worksourceFlag = true
    mockEnqueue.mockReturnValue(false)
    await runOneTick()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(sentPrompts).toHaveLength(0)
    expect(runsForTask()).toHaveLength(0)
  })
})
