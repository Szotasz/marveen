import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import { detectPaneState } from '../pane-state.js'

// Scheduled tasks reach a worksource agent through its queue, not the keyboard.
// Driven through the REAL tick (same harness as
// schedule-runner-fire-current-def.test.ts): a task targeting a sub-agent,
// with the agent's worksourceChannel flag flipped per test.
//   * flag on  -> enqueueWorksourceItem gets the fire, sendPromptToSession does not;
//   * flag off -> the typed path, exactly as before;
//   * the queued content is byte for byte the prompt the typed path would type;
//   * an enqueue that reports "already present" records no run and types nothing;
//   * an enqueue that throws lands in attemptFireTask's catch: an 'error' run;
//   * a queued item is never 'lost': an idle pane, no turn and the grace window
//     long past still holds (the queue's reader owns the delivery) -- the typed
//     path in the exact same state is the control that IS recorded 'lost';
//   * a restart catch-up that reaches the queue is booked 'fired_late'.

const mockAppendTaskRun = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
// Default: the folder of a task is named after it (the normal case).
const mockReadScheduledTask = vi.fn((n: string): ScheduledTask | null => mockListScheduledTasks().find(t => t.name === n) ?? null)
const sentPrompts: Array<{ session: string; prompt: string }> = []
const mockEnqueue = vi.fn((..._args: unknown[]): boolean => true)
// The agent's worksourceChannel opt-in, flipped per test through the mock below.
let worksourceFlag = false
// What the mocked capturePane (agent-process mock below) returns. null, the
// default, is the capture-failed no-signal case the pre-existing tests run
// under; a test that drives the post-fire watchdog sweep sets a real pane text
// here so the REAL detectPaneState classifies it in the tick itself.
let paneText: string | null = null

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

// The scheduler's zone is config.APP_TZ, which reads config-overrides.json and
// .env, never process.env: vi.stubEnv('SCHEDULER_TZ') does not reach it, and
// APP_TZ falls back to the host zone. The fixed-time fixtures below (12:30 and
// 12:20 Budapest) are only due at the startup tick in Budapest time, so on a
// UTC host (the CI runner) they would never fire. Pin the zone here instead.
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, APP_TZ: 'Europe/Budapest', SCHEDULER_TZ_CONFIGURED: 'Europe/Budapest' }
})

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
  capturePane: () => paneText,
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

// A plain `capture-pane -p` snapshot of an IDLE Claude Code pane: finished-turn
// scrollback, an empty input box between its two separator rules, and the
// bypass-mode idle footer. Every test that uses it first proves it against the
// REAL detector, so the fixture is evidence, not an assumption. This is the
// worst case for the watchdog: a pane that never shows a turn, where the typed
// path's verdict is 'lost'.
const IDLE_PANE_TEXT = [
  '  Previous turn output.',
  '',
  '  ────────────────────────────────────────',
  '  ❯',
  '  ────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// 12:30 Budapest = 10:30 UTC: due exactly at the 10:30:05 startup tick (age 5
// s, an on-time fire) and not again for a day, so one fire is all a test sees
// even while the runner keeps ticking. Each test gets its own task NAME:
// runsFor filters by name, and a shared name would pool two tests' run rows.
const QUEUED_ONCE = task({ name: 'ws-idle-never-lost', schedule: '30 12 * * *', targetSession: 'ws-session' })
const TYPED_ONCE = task({ name: 'ws-idle-typed-lost', schedule: '30 12 * * *', targetSession: 'ws-session' })
// 12:20 Budapest = 10:20 UTC: 10 minutes stale at the startup tick, so the
// cold-start catch-up window (last 30 min, no persisted tick stamp) is what
// hands it to the fire -- the restart catch-up path.
const CAUGHT_UP = task({ name: 'ws-catchup-fired-late', schedule: '20 12 * * *', targetSession: 'ws-session' })

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  // Only the startup tick (+5 s): a second tick would fire the task again.
  await vi.advanceTimersByTimeAsync(6_000)
  clearInterval(stop)
}

// runOneTick stops after the startup tick, but the post-fire watchdog sweep
// only gets a say on the LATER 15 s ticks -- keeping the interval alive for
// `ms` of fake time is what lets the sweep run past the 30 s grace window.
async function runForMs(ms: number) {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(ms)
  clearInterval(stop)
}

const runsForTask = () => mockAppendTaskRun.mock.calls.filter(c => c[0] === TASK_NAME)

// runsForTask, parameterised: the tests below each own a uniquely named task,
// so each asserts on exactly its own run rows (same filter shape as above).
const runsFor = (name: string) => mockAppendTaskRun.mock.calls.filter(c => c[0] === name)

describe('schedule runner: a worksource agent gets scheduled prompts through its queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps a mockReturnValue: restore the queue's accept-all default.
    mockEnqueue.mockReturnValue(true)
    vi.useFakeTimers()
    // 10:30:00 UTC; the startup tick runs at 10:30:05, an every-minute occurrence is due.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    sentPrompts.length = 0
    worksourceFlag = false
    paneText = null
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

  it('an enqueue that throws (I/O error) is booked as an error run, like any failed fire', async () => {
    worksourceFlag = true
    mockEnqueue.mockImplementationOnce(() => { throw new Error('EIO') })
    await runOneTick()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(sentPrompts).toHaveLength(0)
    expect(runsForTask()).toEqual([[TASK_NAME, AGENT, 'error']])
  })

  it('a queued item is never recorded lost: idle pane, no turn, past the grace window', async () => {
    // The pane text is proven idle by the REAL detector before anything runs:
    // the never-lost rule under test is only reachable through detectPaneState
    // reading this exact text as 'idle' inside the sweep.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    mockListScheduledTasks.mockReturnValue([QUEUED_ONCE])
    // 4 minutes of 15 s ticks, well past the 30 s grace window (the control
    // below proves this harness does produce 'lost' at this point in time).
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(sentPrompts).toHaveLength(0)
    // Exactly one row, 'fired': the sweep held the entry every tick instead of
    // recording it lost, because the queue's reader owns the delivery.
    expect(runsFor(QUEUED_ONCE.name)).toEqual([[QUEUED_ONCE.name, AGENT, 'fired']])
  })

  it('control: the typed path with the same idle pane IS recorded lost', async () => {
    // Same pane, same timing, flag off: without the worksource hand-over the
    // watchdog must call this exact state 'lost'. This proves the harness can
    // produce a 'lost' verdict at all, so the test above is a real guard.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = false
    paneText = IDLE_PANE_TEXT
    mockListScheduledTasks.mockReturnValue([TYPED_ONCE])
    await runForMs(4 * 60_000)
    expect(sentPrompts).toHaveLength(1)
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(runsFor(TYPED_ONCE.name)).toContainEqual([TYPED_ONCE.name, AGENT, 'lost'])
  })

  it('a restart catch-up through the queue is booked fired_late', async () => {
    // Precondition, proven not assumed: the occurrence is 10 minutes old at
    // the startup tick, which must sit above the late threshold (90 s) and
    // inside the 'task' type's staleness budget, so this is a catch-up fire.
    const { catchUpMaxAgeMs, LATE_CATCHUP_THRESHOLD_MS } = await import('../web/schedule-runner.js')
    expect(LATE_CATCHUP_THRESHOLD_MS).toBeLessThan(10 * 60_000)
    expect(catchUpMaxAgeMs(CAUGHT_UP)).toBeGreaterThan(10 * 60_000)
    worksourceFlag = true
    mockListScheduledTasks.mockReturnValue([CAUGHT_UP])
    await runOneTick()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    // The id carries the occurrence's minute (12:20 Budapest = 10:20 UTC), not the tick's (10:30).
    expect(String(mockEnqueue.mock.calls[0][1])).toMatch(/-20260731T1020Z$/)
    expect(sentPrompts).toHaveLength(0)
    expect(runsFor(CAUGHT_UP.name)).toEqual([[CAUGHT_UP.name, AGENT, 'fired_late']])
  })
})
