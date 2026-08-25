import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// SCHEDPARK814. A scheduled task can be deferred forever by a session that is
// not working at all: an interrupted turn can leave a FRAGMENT of an earlier
// prompt parked in the input box, which keeps isSessionReadyForPrompt false, so
// every retry reads 'busy'. Observed 2026-08-14 on a two-hourly mailbox
// heartbeat: 277 consecutive 'busy' retries over 69 minutes, fixed by hand with
// C-c/C-u, then delivered on the next tick.
//
// The post-send resubmit ladder cannot see this case -- it runs only in the
// seconds after OUR injection and only when the marker is parked in the input
// region -- so the retry queue runs the same stale-parked-input janitor the
// message-router already runs on its own queue.
//
// What this pins:
//   * a long-waiting 'busy' retry asks the janitor, aimed at the SAME session
//     the fire path would have written to;
//   * a young retry does not (an ordinary long turn is not a wedge);
//   * a non-'busy' verdict does not (emptying the box fixes none of those);
//   * the fire path itself is untouched -- a ready session still fires and
//     drains the row without the janitor being consulted.

const mockDeletePendingRetry = vi.fn()
const mockUpdatePendingRetry = vi.fn(() => true)
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSessionExists = vi.fn(() => true)
const mockSessionReady = vi.fn(async () => false)
const mockClearParked = vi.fn(async () => true)
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// The runner persists its last-run map on every fire. Stub the writer so the
// suite never touches the operator's real store.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn(),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(...a),
  updatePendingTaskRetry: () => mockUpdatePendingRetry(),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))

// The alert paths resolve a REAL bot token from install-level config and send
// to the real owner chat. Neutralize the sink: a green suite must never cost
// the operator's attention. The runner sends over getProvider(CHANNEL_PROVIDER)
// since the provider-aware alerts (not sendTelegramMessage any more), so THAT
// is the export to neutralize; everything else stays real.
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
  SCHEDULED_TASKS_DIR: '/tmp/marveen-parked-janitor-no-tasks-dir',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => mockSessionReady(),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => mockSessionExists(),
  // null capture => no first-run gate is detected, and the post-send resubmit
  // loop sees nothing parked and stops.
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: (...a: unknown[]) => mockClearParked(...(a as [])),
  // Only heartbeat tasks fire here, so the bound-channel path is not reached;
  // the export is still mocked so a future non-heartbeat case does not die on
  // "No resolveAgentProvider export is defined on the mock".
  resolveAgentProvider: () => 'telegram',
}))

const TASK: ScheduledTask = {
  name: 'parked-janitor-fixture',
  description: 'parked-input janitor fixture',
  prompt: 'Do the thing.',
  schedule: '0 8 * * *',
  agent: 'parkedagent',
  enabled: true,
  createdAt: 0,
  type: 'heartbeat',
  targetSession: 'parked-test-session',
}

function retryRow(ageMs: number, overrides: Record<string, unknown> = {}) {
  return {
    task_name: TASK.name,
    agent_name: 'parkedagent',
    first_attempt: Date.now() - ageMs,
    last_attempt: Date.now() - 15_000,
    attempt_count: Math.round(ageMs / 15_000),
    last_reason: 'busy',
    alerted_at: null,
    ...overrides,
  }
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(16_000)
  clearInterval(stop)
}

describe('schedule runner: stale-parked-input janitor on the retry queue', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    // A quiet moment: no cron occurrence for the fixture, so only the
    // pending-retry loop acts.
    vi.setSystemTime(new Date('2026-08-14T10:30:00.000Z'))
    mockListScheduledTasks.mockReturnValue([TASK])
    mockSessionExists.mockReturnValue(true)
    mockSessionReady.mockResolvedValue(false)
    mockClearParked.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('asks the janitor once a busy retry has waited past the threshold', async () => {
    mockListPendingRetries.mockReturnValue([retryRow(69 * 60_000)])
    await runOneTick()

    // Aimed at the session the fire path resolves (targetSession override =>
    // local, host null), not at a re-derived guess.
    expect(mockClearParked).toHaveBeenCalledWith('parked-test-session', null)
    // The row is never dropped by the janitor -- delivery happens on the next
    // tick, through the normal retry path.
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
  })

  it('leaves a young busy retry alone', async () => {
    // Below SCHEDULE_JANITOR_PARKED_MIN_AGE_MS: an ordinary long turn, not a wedge.
    mockListPendingRetries.mockReturnValue([retryRow(45_000)])
    await runOneTick()

    expect(mockClearParked).not.toHaveBeenCalled()
  })

  it('does not touch the box for a non-busy verdict', async () => {
    // Session gone + auto-start fails => 'missing'. Old enough to pass the age
    // gate, so only the reason keeps the janitor out.
    mockSessionExists.mockReturnValue(false)
    mockListPendingRetries.mockReturnValue([retryRow(69 * 60_000)])
    await runOneTick()

    expect(mockClearParked).not.toHaveBeenCalled()
  })

  it('stays out of the way when the retry simply fires', async () => {
    mockSessionReady.mockResolvedValue(true)
    mockListPendingRetries.mockReturnValue([retryRow(69 * 60_000)])
    await runOneTick()

    expect(mockDeletePendingRetry).toHaveBeenCalledWith(TASK.name, 'parkedagent')
    expect(mockClearParked).not.toHaveBeenCalled()
  })
})
