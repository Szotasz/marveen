import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import type { PendingTaskRetryRow } from '../db.js'
import { detectPaneState } from '../pane-state.js'
import { BOT_NAME, MAIN_AGENT_ID } from '../config.js'

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
//   * a queued item still in pending/ past the grace window alerts the main
//     agent (the reader is not consuming); in active/ the sweep stays quiet;
//   * a pending/ run that lasts past the owner window escalates exactly once,
//     with the pending wording on both the notice and the owner alert;
//   * a pending/ sample from a SINGLE sweep (a working reader re-offering an
//     unacknowledged item) is not a dead reader: nobody is alerted;
//   * turn evidence from an unrelated transcript write does not close an entry
//     whose item is still in pending/ -- the notice still goes out;
//   * a restart catch-up that reaches the queue is booked 'fired_late';
//   * a pending retry binds the item id to the retry row's first_attempt, and
//     a manual run-now to its own -manual- stamp (both pinned against `now`).

const mockAppendTaskRun = vi.fn()
const mockCreateAgentMessage = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
// Default: the folder of a task is named after it (the normal case).
const mockReadScheduledTask = vi.fn((n: string): ScheduledTask | null => mockListScheduledTasks().find(t => t.name === n) ?? null)
const sentPrompts: Array<{ session: string; prompt: string }> = []
const mockEnqueue = vi.fn((..._args: unknown[]): boolean => true)
// The agent's worksourceChannel opt-in, flipped per test through the mock below.
let worksourceFlag = false
// What worksourceItemStage (the queue probe of the mock below) reports for the
// fired item: a fixed stage, or a function of the current fake time for the
// tests that move the item between queue directories mid-run. null, the
// default, is the "no signal" case.
type WorksourceStage = 'pending' | 'active' | 'done' | null
let worksourceStage: WorksourceStage | (() => WorksourceStage) = null
const stageAt = (): WorksourceStage => (typeof worksourceStage === 'function' ? worksourceStage() : worksourceStage)
// Optional per-id override over stageAt, consulted FIRST: the backlog tests
// need one stage for our item and another for the head items around it. null
// (no override set) and undefined (none for this id) both fall back to
// stageAt(), so every test that drives only worksourceStage keeps its
// behaviour for EVERY id, exactly as today.
let worksourceStageById: ((id: string) => WorksourceStage | undefined) | null = null
// What the mocked worksourcePendingHead reports: the head of pending/ the
// sweep records to judge progress on the NEXT sweep. null, the default, is no
// head at all, so the progress rule never fires and no pre-existing test
// depends on it.
let worksourceHead: () => string | null = () => null
// Newest transcript mtime the mocked readTranscriptMtimeAcrossConfigDirs
// reports, i.e. the sweep's sawTurn evidence; null, the default, is no
// evidence at all.
let transcriptMtime: number | null = null
// Texts handed to the (mocked) channel provider's sendMessage: the owner-facing
// stage-2 scheduler alerts land here. Both knobs below must be set for a send
// to happen -- resolveSchedulerAlertToken and resolveOwnerChatId gate it.
const ownerAlertTexts: string[] = []
let schedulerBotToken: string | null = null
let ownerChat: string | null = null
// What the mocked listPendingTaskRetries returns: the pending-retry loop's
// input, empty by default so the pre-existing tests keep their behaviour.
let pendingRetryRows: PendingTaskRetryRow[] = []
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
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
  listPendingTaskRetries: () => pendingRetryRows,
  getPendingTaskRetry: () => undefined,
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// The runner's alert paths would resolve a REAL bot token; neutralize the sink
// and record what it was handed, so the stage-2 owner alerts are assertable.
vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    readChannelToken: () => schedulerBotToken,
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: vi.fn(async (_token: string, _chatId: string, text: string) => {
        ownerAlertTexts.push(text)
      }),
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

// Only the transcript probe is overridden: the sweep's sawTurn evidence comes
// from it, and a test that wants "some unrelated transcript activity" hands it
// a fresh mtime. Everything else in active-model stays real; the default null
// is exactly what a nonexistent agent dir yields today.
vi.mock('../web/active-model.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/active-model.js')>()
  return {
    ...real,
    readTranscriptMtimeAcrossConfigDirs: () => transcriptMtime,
  }
})

// Stage-2 owner alerts resolve the owner chat through here. Kept as the real
// module unless a test opts in, so every pre-existing test keeps today's
// "no owner chat configured" behaviour.
vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return {
    ...real,
    resolveOwnerChatId: () => ownerChat,
  }
})

vi.mock('../web/worksource-queue.js', () => ({
  enqueueWorksourceItem: (...a: unknown[]) => mockEnqueue(...a),
  worksourceRootFor: (agent: string) => `/tmp/marveen-worksource-test-${agent}`,
  worksourceItemId: (id: number | string) => `msg-${String(id).replace(/[^A-Za-z0-9._-]/g, '')}`,
  worksourceItemStage: (_agent: string, id: string) => {
    const byId = worksourceStageById != null ? worksourceStageById(id) : undefined
    return byId !== undefined ? byId : stageAt()
  },
  worksourcePendingHead: () => worksourceHead(),
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

// A `capture-pane -p` snapshot of a BUSY Claude Code pane, copied from
// QUEUED_NO_SPINNER in src/__tests__/queued-messages-not-idle.test.ts (the
// smallest fixture there that the REAL detector proves 'busy'): the queue hint
// in the input box is the busy signal, the spinner has scrolled out of the
// busy window. Proven against detectPaneState below like IDLE_PANE_TEXT.
const BUSY_PANE_TEXT = [
  '  ⎿  … tool output …',
  '',
  '❯ [inbox-wakeup: pending inter-agent messages]',
  '',
  '────────────────────────────────────────────────────────────────────────',
  '❯ Press up to edit queued messages',
  '────────────────────────────────────────────────────────────────────────',
  '  Opus 5 · ctx 406k/1.0M · 41%',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
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
// Same shape as QUEUED_ONCE, its own name so its run rows and notices are
// assertable in isolation (runsFor filters by name).
const PENDING_ONCE = task({ name: 'ws-pending-alert', schedule: '30 12 * * *', targetSession: 'ws-session' })
// Driven past the owner escalation window (graceMs + OWNER_ESCALATION_EXTRA_MS)
// so the ladder reaches stage 2; its own name so its notices are countable.
const ESCALATED_ONCE = task({ name: 'ws-pending-escalate', schedule: '30 12 * * *', targetSession: 'ws-session' })
// The requeue-blip fixture: the item sits in pending/ for ONE sweep only.
const REQUEUED_ONCE = task({ name: 'ws-pending-blip', schedule: '30 12 * * *', targetSession: 'ws-session' })
// The double-blip fixture: pending/ for ONE sweep twice, minutes apart.
const DOUBLE_BLIP_ONCE = task({ name: 'ws-pending-double-blip', schedule: '30 12 * * *', targetSession: 'ws-session' })
// The backlog fixtures: our item sits behind other work in pending/ for the
// whole run; what separates them is whether the head of pending/ moves.
const BACKLOG_DRAINING_ONCE = task({ name: 'ws-pending-backlog-draining', schedule: '30 12 * * *', targetSession: 'ws-session' })
const BACKLOG_DEAD_ONCE = task({ name: 'ws-pending-backlog-dead', schedule: '30 12 * * *', targetSession: 'ws-session' })
// A fast-acking reader: every head a sweep recorded sits in done/ by the next one.
const BACKLOG_ACKED_ONCE = task({ name: 'ws-pending-backlog-acked', schedule: '30 12 * * *', targetSession: 'ws-session' })
// A dead reader whose recorded head reads null: no signal, which is not progress.
const BACKLOG_NULL_HEAD_ONCE = task({ name: 'ws-pending-backlog-null-head', schedule: '30 12 * * *', targetSession: 'ws-session' })
// A dead reader with fresh items arriving ahead of ours: the head changes, nothing is consumed.
const BACKLOG_DEAD_INFLOW_ONCE = task({ name: 'ws-pending-backlog-dead-inflow', schedule: '30 12 * * *', targetSession: 'ws-session' })
// The busy-path wording fixture: a busy pane with stuckAfterMinutes 1 (clamped
// to a 60 s timeoutMs), so the pane-busy ladder is the one that fires.
const BUSY_BLIP_ONCE = task({ name: 'ws-busy-blip-wording', schedule: '30 12 * * *', targetSession: 'ws-session', stuckAfterMinutes: 1 })
// An unrelated transcript write sets sawTurn while the item never leaves
// pending/ (the agent chats with a human, its reader is dead).
const CHATTED_ONCE = task({ name: 'ws-pending-chatty', schedule: '30 12 * * *', targetSession: 'ws-session' })
// Fires only through the pending-retry loop: 03:00 UTC never falls inside the
// startup tick's scan window, so the cron path cannot race the retry binding.
const RETRY_ONCE = task({ name: 'ws-retry-binding', schedule: '0 3 * * *', targetSession: 'ws-session' })

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
    worksourceStage = null
    worksourceStageById = null
    worksourceHead = () => null
    transcriptMtime = null
    ownerAlertTexts.length = 0
    schedulerBotToken = null
    ownerChat = null
    pendingRetryRows = []
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

  it('a queued item still in pending/ past the grace window alerts the main agent, not just holds', async () => {
    // Same idle-pane/no-turn state as the never-lost test above, but the item
    // never left pending/: no reader is consuming the queue. Holding quietly
    // until maxTrackMs (6 h) is the silent-loss hole this closes -- the notice
    // must reach the main agent and name the item.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    worksourceStage = 'pending'
    mockListScheduledTasks.mockReturnValue([PENDING_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const itemId = String(mockEnqueue.mock.calls[0][1])
    const notice = mockCreateAgentMessage.mock.calls.find(c => c[0] === 'system' && c[1] === MAIN_AGENT_ID)
    expect(notice).toBeDefined()
    expect(String(notice?.[2])).toContain('pending/')
    expect(String(notice?.[2])).toContain(itemId)
    // The alert ladder replaced the silent hold, not the never-lost rule: the
    // run is still only the one 'fired' row.
    expect(runsFor(PENDING_ONCE.name)).toEqual([[PENDING_ONCE.name, AGENT, 'fired']])
  })

  it('a pending/ item nobody picks up escalates to the owner exactly once, both texts in the pending wording', async () => {
    // Same state as the alert test above, held past graceMs + the owner
    // escalation window: the ladder must reach stage 2, and both the main-agent
    // notice and the owner alert must say what is actually wrong -- the item is
    // still in pending/ -- not a word about pane busyness. Exactly one of each:
    // the one-shot flags have to hold across every later sweep.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    const { OWNER_ESCALATION_EXTRA_MS } = await import('../pending-retries.js')
    const { TASK_FIRE_GRACE_MS } = await import('../web/schedule-runner.js')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    worksourceStage = 'pending'
    schedulerBotToken = 'test-token'
    ownerChat = '4242'
    mockListScheduledTasks.mockReturnValue([ESCALATED_ONCE])
    // Past the owner window with a tick to spare; maxTrack (6 h) is far above,
    // so the entry is still being swept when stage 2 comes due.
    await runForMs(TASK_FIRE_GRACE_MS + OWNER_ESCALATION_EXTRA_MS + 2 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const itemId = String(mockEnqueue.mock.calls[0][1])
    const notices = mockCreateAgentMessage.mock.calls
      .filter(c => c[0] === 'system' && c[1] === MAIN_AGENT_ID && String(c[2]).includes('pending/ mappában áll'))
    expect(notices).toHaveLength(1)
    expect(String(notices[0][2])).toContain(itemId)
    const ownerAlerts = ownerAlertTexts.filter(t => t.includes('pending/ mappában áll'))
    expect(ownerAlerts).toHaveLength(1)
    // The owner-facing variant carries the bot name like the busy one does, so
    // the two are indistinguishable in the operator's channel.
    expect(ownerAlerts[0].startsWith(`[${BOT_NAME} scheduler]`)).toBe(true)
    expect(runsFor(ESCALATED_ONCE.name)).toEqual([[ESCALATED_ONCE.name, AGENT, 'fired']])
  })

  it('a single-sweep pending/ blip (a working reader re-offering) alerts nobody', async () => {
    // requeueStale moves an unacknowledged active/ item back to pending/ and
    // the next poll takes it again, so one sweep can sample 'pending' from a
    // healthy queue. That single sample, 2 minutes after the injection and long
    // past the grace window, must not be read as "nobody picked it up".
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    schedulerBotToken = 'test-token'
    ownerChat = '4242'
    // active/ everywhere except the 10:32:00 sweep, which is a tick time, so
    // exactly one sweep sees the item back in pending/.
    let blipServed = false
    worksourceStage = () => {
      if (!blipServed && Date.now() >= Date.UTC(2026, 6, 31, 10, 32, 0)) {
        blipServed = true
        return 'pending'
      }
      return 'active'
    }
    mockListScheduledTasks.mockReturnValue([REQUEUED_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockCreateAgentMessage.mock.calls.filter(c => c[1] === MAIN_AGENT_ID)).toHaveLength(0)
    expect(ownerAlertTexts).toHaveLength(0)
    // Still only the one 'fired' row: a blip is neither a loss nor a finish.
    expect(runsFor(REQUEUED_ONCE.name)).toEqual([[REQUEUED_ONCE.name, AGENT, 'fired']])
  })

  it('two pending/ blips minutes apart (a working reader re-offering twice) alert nobody', async () => {
    // requeueStale does not stop after one re-offer: a working reader can put
    // the item back in pending/ again minutes later, so the sweep samples
    // 'pending' for one sweep, twice. The first blip stamps
    // worksourcePendingSince; the active/ samples in between must CLEAR it --
    // otherwise the second blip, minutes later, measures from the first one
    // and a healthy queue looks like a pending/ run longer than graceMs.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    schedulerBotToken = 'test-token'
    ownerChat = '4242'
    // 'pending' exactly twice and nowhere else: on the very first call (the
    // first sweep after the hand-over) and on the first call at/after 10:33:00.
    // Counters/flags rather than a time window, so each blip is served once
    // however the tick times land.
    let pendingReturns = 0
    let firstBlipServed = false
    let secondBlipServed = false
    worksourceStage = () => {
      if (!firstBlipServed) {
        firstBlipServed = true
        pendingReturns++
        return 'pending'
      }
      if (!secondBlipServed && Date.now() >= Date.UTC(2026, 6, 31, 10, 33, 0)) {
        secondBlipServed = true
        pendingReturns++
        return 'pending'
      }
      return 'active'
    }
    mockListScheduledTasks.mockReturnValue([DOUBLE_BLIP_ONCE])
    await runForMs(5 * 60_000)
    // Both blips were actually served, so this cannot pass by never reaching
    // the second one.
    expect(pendingReturns).toBe(2)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockCreateAgentMessage.mock.calls.filter(c => c[1] === MAIN_AGENT_ID)).toHaveLength(0)
    expect(ownerAlertTexts).toHaveLength(0)
    // Still only the one 'fired' row: a blip is neither a loss nor a finish.
    expect(runsFor(DOUBLE_BLIP_ONCE.name)).toEqual([[DOUBLE_BLIP_ONCE.name, AGENT, 'fired']])
  })

  it('a healthy reader draining a backlog ahead of the item alerts nobody', async () => {
    // Ten-plus items sit ahead of ours in pending/, so a healthy reader needs
    // far more than the 30 s grace window to reach it and ours stays in
    // pending/ for the whole run -- the exact state that used to look like a
    // dead reader. Here the head of pending/ is a NEW id on every sweep and
    // every previous head has moved on to active/, which is progress: the
    // sweep restarts the pending run on each of them and the run never spans
    // the grace window.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    schedulerBotToken = 'test-token'
    ownerChat = '4242'
    const consumedHeads: string[] = []
    let headCalls = 0
    // Our item (the only sched- id in the queue) never moves; every head a
    // previous sweep recorded is long gone from pending/.
    worksourceStageById = (id: string) => {
      if (id.startsWith('sched-')) return 'pending'
      if (consumedHeads.includes(id)) return 'active'
      return undefined
    }
    worksourceHead = () => {
      headCalls++
      const head = `msg-${String(consumedHeads.length + 1).padStart(4, '0')}`
      consumedHeads.push(head)
      return head
    }
    mockListScheduledTasks.mockReturnValue([BACKLOG_DRAINING_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockCreateAgentMessage.mock.calls.filter(c => c[1] === MAIN_AGENT_ID)).toHaveLength(0)
    expect(ownerAlertTexts).toHaveLength(0)
    // The progress path was actually exercised: the sweep asked for the head
    // on (nearly) every one of its 15 s ticks, not just once or twice.
    expect(headCalls).toBeGreaterThanOrEqual(8)
    expect(runsFor(BACKLOG_DRAINING_ONCE.name)).toEqual([[BACKLOG_DRAINING_ONCE.name, AGENT, 'fired']])
  })

  it('a dead reader behind a backlog still alerts', async () => {
    // The same backlog, but the head of pending/ never changes either: nothing
    // is being consumed, ours is not waiting behind progress. The pending run
    // spans the grace window and the main-agent notice goes out -- once, in
    // the pending wording.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    worksourceStageById = (id: string) => (id.startsWith('sched-') || id === 'msg-0001' ? 'pending' : undefined)
    worksourceHead = () => 'msg-0001'
    mockListScheduledTasks.mockReturnValue([BACKLOG_DEAD_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const notices = mockCreateAgentMessage.mock.calls
      .filter(c => c[0] === 'system' && c[1] === MAIN_AGENT_ID && String(c[2]).includes('pending/ mappában áll'))
    expect(notices).toHaveLength(1)
    expect(runsFor(BACKLOG_DEAD_ONCE.name)).toEqual([[BACKLOG_DEAD_ONCE.name, AGENT, 'fired']])
  })

  it('a healthy reader whose agent acknowledges fast (each head already in done/) alerts nobody', async () => {
    // The draining backlog above, one step faster: by the time a sweep asks
    // about the head the previous sweep recorded, that item is not merely
    // active/ but already acknowledged into done/. That is just as much
    // progress -- a reader burning through the backlog, the agent finishing
    // each item within a sweep -- so the pending run must restart on it too
    // and never span the grace window. A rule that restarts only on 'active'
    // would read this healthy queue as a dead one and alert.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    schedulerBotToken = 'test-token'
    ownerChat = '4242'
    const consumedHeads: string[] = []
    let headCalls = 0
    // Our item (the only sched- id in the queue) never moves; every head a
    // previous sweep recorded has since been acknowledged into done/.
    worksourceStageById = (id: string) => {
      if (id.startsWith('sched-')) return 'pending'
      if (consumedHeads.includes(id)) return 'done'
      return undefined
    }
    worksourceHead = () => {
      headCalls++
      const head = `msg-${String(consumedHeads.length + 1).padStart(4, '0')}`
      consumedHeads.push(head)
      return head
    }
    mockListScheduledTasks.mockReturnValue([BACKLOG_ACKED_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockCreateAgentMessage.mock.calls.filter(c => c[1] === MAIN_AGENT_ID)).toHaveLength(0)
    expect(ownerAlertTexts).toHaveLength(0)
    // The progress path was actually exercised on (nearly) every 15 s tick.
    expect(headCalls).toBeGreaterThanOrEqual(8)
    expect(runsFor(BACKLOG_ACKED_ONCE.name)).toEqual([[BACKLOG_ACKED_ONCE.name, AGENT, 'fired']])
  })

  it('a dead reader whose previous head reads null (no signal) still alerts', async () => {
    // The dead backlog again, except the head the previous sweep recorded no
    // longer answers the stage probe at all: null, the unreadable-queue case,
    // not 'active' or 'done'. No signal is no progress -- the only evidence
    // the queue moved is a stage that says so -- so the pending run spans the
    // grace window and the notice goes out, exactly once, in the pending
    // wording. Counting null as progress would make the vanishing of the
    // evidence look like the consumption of the queue.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    worksourceStageById = (id: string) => {
      if (id.startsWith('sched-')) return 'pending'
      if (id === 'msg-0001') return null
      return undefined
    }
    worksourceHead = () => 'msg-0001'
    mockListScheduledTasks.mockReturnValue([BACKLOG_NULL_HEAD_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const notices = mockCreateAgentMessage.mock.calls
      .filter(c => c[0] === 'system' && c[1] === MAIN_AGENT_ID && String(c[2]).includes('pending/ mappában áll'))
    expect(notices).toHaveLength(1)
    expect(runsFor(BACKLOG_NULL_HEAD_ONCE.name)).toEqual([[BACKLOG_NULL_HEAD_ONCE.name, AGENT, 'fired']])
  })

  it('a dead reader with new items arriving ahead of ours still alerts', async () => {
    // The head of pending/ is a new id on every sweep here too, but only
    // because fresh work keeps arriving ahead of ours: every one of those ids
    // is itself still in pending/, nothing is being consumed. A changed head
    // id is not progress on its own -- only the previous head having moved on
    // to active/ or done/ is -- so the pending run spans the grace window and
    // the notice goes out, exactly once, in the pending wording.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    let headCalls = 0
    worksourceStageById = (id: string) => (id.startsWith('sched-') || id.startsWith('msg-') ? 'pending' : undefined)
    worksourceHead = () => {
      headCalls++
      return `msg-${String(headCalls).padStart(4, '0')}`
    }
    mockListScheduledTasks.mockReturnValue([BACKLOG_DEAD_INFLOW_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const notices = mockCreateAgentMessage.mock.calls
      .filter(c => c[0] === 'system' && c[1] === MAIN_AGENT_ID && String(c[2]).includes('pending/ mappában áll'))
    expect(notices).toHaveLength(1)
    expect(headCalls).toBeGreaterThanOrEqual(8)
    expect(runsFor(BACKLOG_DEAD_INFLOW_ONCE.name)).toEqual([[BACKLOG_DEAD_INFLOW_ONCE.name, AGENT, 'fired']])
  })

  it('a busy-path alert that samples a one-poll pending/ blip keeps the busy wording', async () => {
    // A working reader can show the item in pending/ for one poll. If that
    // single sample lands on the very sweep the busy ladder fires on, the
    // alert must not claim the item was never picked up: it says what it
    // measures, the pane having been busy since the injection.
    expect(detectPaneState(BUSY_PANE_TEXT)).toBe('busy')
    const { OWNER_ESCALATION_EXTRA_MS } = await import('../pending-retries.js')
    // Guard: 3 minutes of fake time stays below timeoutMs + the owner window,
    // so only stage 1 (the main-agent notice) can ever fire in this run.
    expect(3 * 60_000).toBeLessThan(60_000 + OWNER_ESCALATION_EXTRA_MS)
    worksourceFlag = true
    paneText = BUSY_PANE_TEXT
    // stuckAfterMinutes 1 -> resolveStuckTimeoutMs clamps to 60 s, and the
    // fire is at 10:30:05 with 15 s ticks, so the first sweep with
    // elapsed >= timeoutMs is 10:31:05 -- that instant is the busy alert's due
    // moment, and the one-poll blip is served exactly there.
    const busyAlertDueMs = Date.UTC(2026, 6, 31, 10, 31, 5)
    let blipServed = false
    let pendingServedAt: number | undefined
    worksourceStage = () => {
      if (!blipServed && Date.now() >= busyAlertDueMs) {
        blipServed = true
        pendingServedAt = Date.now()
        return 'pending'
      }
      return 'active'
    }
    // Record the fake time of every main-agent notice, preserving the mock's
    // return value; restored in the finally so it cannot leak into later tests.
    const originalCreateAgentMessage = mockCreateAgentMessage.getMockImplementation()
    const noticeTakenAt: number[] = []
    mockCreateAgentMessage.mockImplementation((...args: unknown[]) => {
      if (args[0] === 'system' && args[1] === MAIN_AGENT_ID) noticeTakenAt.push(Date.now())
      return originalCreateAgentMessage?.(...args)
    })
    try {
      mockListScheduledTasks.mockReturnValue([BUSY_BLIP_ONCE])
      await runForMs(3 * 60_000)
      const notices = mockCreateAgentMessage.mock.calls.filter(c => c[0] === 'system' && c[1] === MAIN_AGENT_ID)
      expect(notices).toHaveLength(1)
      // The blip and the alert were in the SAME sweep -- the coincidence is
      // recorded, not assumed, and it is what makes this test able to fail.
      expect(pendingServedAt).toBeDefined()
      expect(blipServed).toBe(true)
      expect(pendingServedAt).toBe(noticeTakenAt[0])
      // The pane-busy wording, not the queue wording: one pending/ sample says
      // nothing about nobody picking the item up.
      expect(String(notices[0][2])).not.toContain('pending/ mappában áll')
      // Still only the one 'fired' row: the alert opens nothing new.
      expect(runsFor(BUSY_BLIP_ONCE.name)).toEqual([[BUSY_BLIP_ONCE.name, AGENT, 'fired']])
    } finally {
      mockCreateAgentMessage.mockImplementation(originalCreateAgentMessage ?? (() => undefined))
    }
  })

  it('turn evidence from an unrelated transcript write does not close an entry whose item is still in pending/', async () => {
    // sawTurn is set by ANY transcript write after the injection: here the agent
    // is chatting with a human while its queue reader is dead. Idle pane + a
    // turn used to mean 'done', which closed the entry and left the item
    // sitting in pending/ silently -- the notice must still go out.
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    worksourceStage = 'pending'
    // A transcript write after the fire (10:30:05), so the first sweep already
    // carries turn evidence that has nothing to do with the queued item.
    transcriptMtime = Date.UTC(2026, 6, 31, 10, 30, 30)
    mockListScheduledTasks.mockReturnValue([CHATTED_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const notices = mockCreateAgentMessage.mock.calls
      .filter(c => c[0] === 'system' && c[1] === MAIN_AGENT_ID && String(c[2]).includes('pending/ mappában áll'))
    expect(notices).toHaveLength(1)
    // The entry is still open (a 'done' would have closed it), so the one
    // 'fired' row is all this run ever wrote.
    expect(runsFor(CHATTED_ONCE.name)).toEqual([[CHATTED_ONCE.name, AGENT, 'fired']])
  })

  it('the same entry with the item in active/ stays quiet: the reader owns the hand-off', async () => {
    expect(detectPaneState(IDLE_PANE_TEXT)).toBe('idle')
    worksourceFlag = true
    paneText = IDLE_PANE_TEXT
    worksourceStage = 'active'
    mockListScheduledTasks.mockReturnValue([PENDING_ONCE])
    await runForMs(4 * 60_000)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(mockCreateAgentMessage.mock.calls.filter(c => c[1] === MAIN_AGENT_ID)).toHaveLength(0)
    expect(runsFor(PENDING_ONCE.name)).toEqual([[PENDING_ONCE.name, AGENT, 'fired']])
  })

  it('a pending retry binds the item id to the row\'s first_attempt minute, not the firing tick', async () => {
    worksourceFlag = true
    mockListScheduledTasks.mockReturnValue([RETRY_ONCE])
    // 10:28 UTC, while the startup tick fires at 10:30:05 -- two different UTC
    // minutes, so binding the id to first_attempt and binding it to `now`
    // give demonstrably different ids.
    const firstAttempt = Date.UTC(2026, 6, 31, 10, 28, 0)
    pendingRetryRows = [{
      id: 1,
      task_name: RETRY_ONCE.name,
      agent_name: AGENT,
      first_attempt: firstAttempt,
      last_attempt: firstAttempt,
      attempt_count: 1,
      last_reason: 'busy',
      alert_sent_at: null,
      owner_alert_sent_at: null,
    }]
    await runOneTick()
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const { scheduledWorksourceItemId } = await import('../web/schedule-runner.js')
    expect(String(mockEnqueue.mock.calls[0][1])).toBe(scheduledWorksourceItemId(RETRY_ONCE.name, { kind: 'occurrence', at: firstAttempt }))
  })

  it('runScheduledTaskNow queues a manual item: -manual- id bound to the run-now timestamp', async () => {
    worksourceFlag = true
    mockListScheduledTasks.mockReturnValue([TASK])
    vi.resetModules()
    const { runScheduledTaskNow, scheduledWorksourceItemId } = await import('../web/schedule-runner.js')
    // Fake timers pin Date.now(): the `now` the fire path sees is exactly this.
    const now = Date.now()
    const res = await runScheduledTaskNow(TASK_NAME)
    expect(res.ok).toBe(true)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const itemId = String(mockEnqueue.mock.calls[0][1])
    expect(itemId).toContain('-manual-')
    expect(itemId).toBe(scheduledWorksourceItemId(TASK_NAME, { kind: 'manual', at: now }))
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
