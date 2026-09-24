import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// End-to-end test of the host-suspend catch-up gate, driving the REAL runCheck
// loop.
//
// Scenario: the runner ticks normally at 06:00, the host then sleeps for three
// hours while the process stays alive (fake timers let the wall clock jump
// WITHOUT firing the skipped intervals -- exactly what a suspend does), and
// the next tick has to decide what part of the gap is still worth acting on.
// A second scenario suspends across the quiet band and resumes at 02:00.
//
// What this pins that a pure-function test cannot:
//   * a daily 08:00 slot swallowed by the sleep really does fire on resume,
//     and is recorded 'fired_late' rather than as a normal run;
//   * a */5 heartbeat with 37 swallowed slots fires ONCE, not 37 times --
//     and fires AT ALL, which the window-start double-fire guard prevented;
//   * an evening slot from behind the quiet band is NOT resurrected;
//   * the following normal tick does not replay anything;
//   * a resume INSIDE the quiet band fires nothing at all.

const mockAppendTaskRun = vi.fn()
const mockInsertPendingRetry = vi.fn()
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSendPrompt = vi.fn(() => 'landed')
const mockIsSessionReady = vi.fn(() => true)
const mockLoggerInfo = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The runner persists its last-run map to store/schedule-last-run.json on every
// fire. Stub the writer so the suite never touches the operator's real store.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: (...a: unknown[]) => mockInsertPendingRetry(...a),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-gap-catchup-no-tasks-dir',
}))

// The runner's catch-up summary and alert paths resolve a REAL bot token from
// install-level config (HOME-based, so a test worktree does not isolate them)
// and send to the real owner chat -- this exact test once delivered two
// "[TESZT]" catch-up summaries to the operator's phone. Neutralize the sink:
// a green suite must never cost the operator's attention.
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => mockIsSessionReady(),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  // null capture => the post-send resubmit loop sees nothing parked and stops.
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
}))

const TZ = 'Europe/Budapest'

// A task whose name cannot collide with anything in the operator's real
// store/schedule-last-run.json (which the runner reloads on start).
function task(overrides: Partial<ScheduledTask> & { name: string; schedule: string }): ScheduledTask {
  return {
    description: 'gap catch-up fixture',
    prompt: 'Do the thing.',
    agent: 'gapagent',
    enabled: true,
    createdAt: 0,
    type: 'heartbeat',
    // Pins the target session so the fire path needs no agent-config lookup.
    targetSession: 'gap-test-session',
    ...overrides,
  }
}

// type 'task' mirrors an operator-facing daily (morning briefing, daily audit):
// the per-type staleness budget (task: 180 min) is what lets a ~67-min-late
// occurrence still fire as a catch-up; a 'heartbeat' fixture would hit the
// 30-min budget and be recorded 'missed' instead.
const DAILY_0800 = task({ name: 'catchup-e2e-daily-0800', schedule: '0 8 * * *', type: 'task' })
const HB_5MIN = task({ name: 'catchup-e2e-hb-5min', schedule: '*/5 6-21 * * *' })
const EVENING_2015 = task({ name: 'catchup-e2e-evening-2015', schedule: '15 20 * * *', type: 'task' })

// 06:00:00 local (CEST) -- the last healthy tick before the host slept.
const BEFORE_SLEEP = new Date('2026-07-31T04:00:00.000Z')
// 09:06:10 local; the first pending interval then fires ten seconds later.
const AFTER_SLEEP = new Date('2026-07-31T07:06:10.000Z')
// 20:00:00 local the previous evening -- the last tick before an overnight
// suspend, placed BEFORE the 20:15 slot so that slot genuinely falls in the gap.
const BEFORE_SLEEP_EVENING = new Date('2026-07-30T18:00:00.000Z')
// 02:00:10 local -- a resume in the middle of the quiet band.
const AFTER_SLEEP_QUIET = new Date('2026-07-31T00:00:10.000Z')

async function loadRunner() {
  vi.resetModules()
  return await import('../web/schedule-runner.js')
}

function runsFor(name: string): string[] {
  return mockAppendTaskRun.mock.calls.filter(c => c[0] === name).map(c => String(c[2]))
}

describe('schedule runner: host-suspend catch-up', () => {
  let stop: NodeJS.Timeout | null = null

  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', TZ)
    vi.clearAllMocks()
    mockIsSessionReady.mockReturnValue(true)
    mockListPendingRetries.mockReturnValue([])
    vi.useFakeTimers()
  })

  afterEach(() => {
    if (stop) clearInterval(stop)
    stop = null
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('fires the slots the sleep swallowed -- once each -- and marks them late', async () => {
    mockListScheduledTasks.mockReturnValue([DAILY_0800, HB_5MIN, EVENING_2015])
    vi.setSystemTime(BEFORE_SLEEP)
    const { startScheduleRunner } = await loadRunner()
    stop = startScheduleRunner()

    // First tick, 06:00:05 local. Only the */5 heartbeat is due here -- note
    // that this stamps its lastRun with the tick time, which is exactly the
    // scan-window start the NEXT tick would have used.
    await vi.advanceTimersByTimeAsync(5000)
    expect(runsFor(HB_5MIN.name)).toEqual(['fired'])
    expect(runsFor(DAILY_0800.name)).toEqual([])
    mockAppendTaskRun.mockClear()
    mockSendPrompt.mockClear()
    mockLoggerInfo.mockClear()

    // The host sleeps. Wall clock jumps ~3h; NO interval fires meanwhile.
    vi.setSystemTime(AFTER_SLEEP)
    await vi.advanceTimersByTimeAsync(60_000)

    // The 08:00 daily slot was inside the sleep -> caught up, flagged late.
    expect(runsFor(DAILY_0800.name)).toEqual(['fired_late'])
    // 37 heartbeat slots were inside the sleep -> exactly ONE fire. Whether it
    // stamps 'fired' or 'fired_late' depends on where the resume tick lands
    // relative to the 90s late threshold (the selection gate picks the MOST
    // RECENT occurrence, 09:05); the guarded property is the single fire. That
    // it fires at all is the occurrence-guard fix: its lastRun equals the scan
    // window start, so the old `lastRun >= fromMs` form dropped it.
    expect(runsFor(HB_5MIN.name)).toHaveLength(1)
    expect(runsFor(HB_5MIN.name)[0]).toMatch(/^fired(_late)?$/)
    // The 20:15 slot sits behind the quiet band -> stays missed.
    expect(runsFor(EVENING_2015.name)).toEqual([])
    expect(mockSendPrompt).toHaveBeenCalledTimes(2)

    // The gap is auditable: without this line a suspend leaves no trace at all.
    const summary = mockLoggerInfo.mock.calls.find(c =>
      String(c[1]).includes('Schedule tick gap detected (host suspend?)'),
    )
    expect(summary).toBeDefined()
    // ~3h06m depending on where the resume tick lands; the audited facts are
    // the gap magnitude and that at least the daily counted as a catch-up (the
    // heartbeat's most-recent occurrence may classify on-time, see above).
    expect(summary?.[0].gapMinutes).toBeGreaterThanOrEqual(185)
    expect(summary?.[0].catchUpFires).toBeGreaterThanOrEqual(1)

    // The NEXT normal tick must not replay anything.
    mockSendPrompt.mockClear()
    mockAppendTaskRun.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockAppendTaskRun).not.toHaveBeenCalled()
  })

  it('waking inside the quiet band fires nothing and says so', async () => {
    mockListScheduledTasks.mockReturnValue([DAILY_0800, HB_5MIN, EVENING_2015])
    vi.setSystemTime(BEFORE_SLEEP_EVENING)
    const { startScheduleRunner } = await loadRunner()
    stop = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(5000)
    mockAppendTaskRun.mockClear()
    mockSendPrompt.mockClear()
    mockLoggerInfo.mockClear()

    vi.setSystemTime(AFTER_SLEEP_QUIET)
    await vi.advanceTimersByTimeAsync(60_000)

    // The 20:15 slot and six hours of heartbeats fell inside the gap, and the
    // contiguous scan window would have swept every one of them -- but the
    // resume is at 02:00, so night slots stay missed rather than landing in a
    // sleeping operator's chat (or as a burst of 'missed' rows).
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockAppendTaskRun).not.toHaveBeenCalled()
    const quiet = mockLoggerInfo.mock.calls.find(c =>
      String(c[1]).includes('inside the quiet band'),
    )
    expect(quiet).toBeDefined()
  })

  it('an ordinary tick sequence logs no gap and fires on its own cadence', async () => {
    mockListScheduledTasks.mockReturnValue([HB_5MIN])
    // 09:00:15 local, so the first tick lands at 09:00:20. Deliberately
    // mid-minute: cron-parser's prev() is exclusive, so a tick landing exactly
    // ON a slot boundary reads the PREVIOUS slot and would be classed late by
    // the (pre-existing) cold-start window.
    vi.setSystemTime(new Date('2026-07-31T07:00:15.000Z'))
    const { startScheduleRunner } = await loadRunner()
    stop = startScheduleRunner()
    await vi.advanceTimersByTimeAsync(5000)
    expect(runsFor(HB_5MIN.name)).toEqual(['fired']) // 09:00:00 slot, on time
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)

    mockSendPrompt.mockClear()
    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(60_000) // 09:01..09:04
    expect(mockSendPrompt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000) // 09:05
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    // Nothing was late, so no 'fired_late' rows and no gap log.
    expect(runsFor(HB_5MIN.name)).toEqual(['fired', 'fired'])
    expect(
      mockLoggerInfo.mock.calls.some(c => String(c[1]).includes('Schedule tick gap')),
    ).toBe(false)
  })
})
