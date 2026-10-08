import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// TESTFOLLOWUP1007G (a #1723 review finding): the pending-retry loop checks
// that the task exists and is enabled BEFORE `await retryPreCheck(...)`, and
// the pre-check runs off the event loop for up to its time limit. An operator
// who disables or deletes the task, or cancels the retry, while it runs used
// to be overruled: the retry fired anyway. The runner now reads both again
// after the await.
//
// What this measures, through the real tick: the pre-check is a fake child
// process whose run CHANGES the state before it closes -- the change happens
// exactly inside the await, the window the finding is about.
//   * task disabled during the pre-check -> no fire (the next tick drops the row);
//   * task deleted during the pre-check  -> no fire (the next tick drops the row);
//   * retry cancelled during the pre-check -> no fire, nothing re-created;
//   * control: nothing changes             -> the retry fires and drains.

const mockAppendTaskRun = vi.fn()
const mockDeletePendingRetry = vi.fn()
const mockUpdatePendingRetry = vi.fn(() => true)
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockGetPendingRetry = vi.fn((..._a: unknown[]): unknown => ({ id: 1 }))
const mockSendPrompt = vi.fn(() => 'sent')
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
// What the fake pre-check does while it "runs", before it closes.
let duringPreCheck: () => void = () => {}
let preCheckRuns = 0

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: vi.fn(() => {
      preCheckRuns++
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      // Off the current call stack, but not on a timer: the fake clock does not hold it back.
      void Promise.resolve().then(() => {
        duringPreCheck()
        child.stdout.emit('data', Buffer.from('2 actionable items\n'))
        child.emit('close', 0)
      })
      return child
    }),
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  getPendingTaskRetry: (...a: unknown[]) => mockGetPendingRetry(...a),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(...a),
  updatePendingTaskRetry: mockUpdatePendingRetry,
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
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-retry-recheck-no-tasks-dir',
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

// The pre-check needs a script that EXISTS (runPreCheckAsync checks before it
// spawns); its content never runs, the fake spawn above stands in for it.
const scriptDir = mkdtempSync(join(tmpdir(), 'retry-recheck-'))
const scriptPath = join(scriptDir, 'pre-check.sh')
writeFileSync(scriptPath, '#!/usr/bin/env bash\necho unused\n', { mode: 0o755 })
afterAll(() => rmSync(scriptDir, { recursive: true, force: true }))

const TASK: ScheduledTask = {
  name: 'retry-recheck-daily',
  description: 'retry-recheck fixture',
  prompt: 'Do the thing.',
  schedule: '0 8 * * *',
  agent: 'retryagent',
  enabled: true,
  createdAt: 0,
  type: 'task',
  targetSession: 'retry-test-session',
  preCheck: scriptPath,
}

const ROW = {
  task_name: TASK.name,
  agent_name: 'retryagent',
  first_attempt: Date.now() - 5 * 60000,
  last_attempt: Date.now() - 60000,
  attempt_count: 5,
  last_reason: 'busy',
  alerted_at: null,
}

async function runOneTick() {
  vi.resetModules()
  const { startScheduleRunner, resetPreCheckAnswersForTests } = await import('../web/schedule-runner.js')
  resetPreCheckAnswersForTests()
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(61_000)
  clearInterval(stop)
}

function fired(): boolean {
  return mockSendPrompt.mock.calls.length > 0
}

describe('schedule runner: a pending retry re-reads the task and the row after its pre-check', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    mockSendPrompt.mockImplementation(() => 'sent')
    vi.useFakeTimers()
    // A quiet moment (no cron occurrence for the fixture): only the retry loop acts.
    vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
    preCheckRuns = 0
    duringPreCheck = () => {}
    mockListScheduledTasks.mockReturnValue([TASK])
    mockListPendingRetries.mockReturnValue([{ ...ROW }])
    mockGetPendingRetry.mockReturnValue({ id: 1 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('control: nothing changes during the pre-check -> the retry fires and drains', async () => {
    await runOneTick()
    expect(preCheckRuns).toBeGreaterThan(0)
    expect(fired()).toBe(true)
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(TASK.name, 'retryagent')
  })

  it('the task is disabled during the pre-check -> no fire, and the row is dropped by a later tick', async () => {
    duringPreCheck = () => { mockListScheduledTasks.mockReturnValue([{ ...TASK, enabled: false }]) }
    await runOneTick()
    expect(preCheckRuns).toBeGreaterThan(0)
    expect(fired()).toBe(false)
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(TASK.name, 'retryagent')
  })

  it('the task is deleted during the pre-check -> no fire, and the row is dropped by a later tick', async () => {
    duringPreCheck = () => { mockListScheduledTasks.mockReturnValue([]) }
    await runOneTick()
    expect(preCheckRuns).toBeGreaterThan(0)
    expect(fired()).toBe(false)
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(TASK.name, 'retryagent')
  })

  // SCHEDRECHECK1007: the fire uses the definition read AFTER the await.
  it('the prompt is edited during the pre-check -> the EDITED prompt goes out', async () => {
    duringPreCheck = () => { mockListScheduledTasks.mockReturnValue([{ ...TASK, prompt: 'Do the EDITED thing.' }]) }
    await runOneTick()
    expect(preCheckRuns).toBeGreaterThan(0)
    const prompts = mockSendPrompt.mock.calls.map(c => String((c as unknown[])[1]))
    expect(prompts.length).toBeGreaterThan(0)
    for (const p of prompts) {
      expect(p).toContain('Do the EDITED thing.')
      expect(p).not.toContain('Do the thing.')
    }
  })

  // SCHEDRECHECK1007: an earlier row's fire is an await too. A second retry, of
  // a task WITHOUT a pre-check, whose task is disabled while the first one
  // fires, must not fire from the tick's snapshot.
  it('a task without a pre-check, disabled while an earlier retry fires -> it does not fire', async () => {
    const PLAIN: ScheduledTask = { ...TASK, name: 'retry-recheck-plain', preCheck: undefined, targetSession: 'plain-session' }
    mockListScheduledTasks.mockReturnValue([TASK, PLAIN])
    mockListPendingRetries.mockReturnValue([{ ...ROW }, { ...ROW, task_name: PLAIN.name }])
    mockSendPrompt.mockImplementation(((...a: unknown[]) => {
      if (a[0] === 'retry-test-session') mockListScheduledTasks.mockReturnValue([TASK, { ...PLAIN, enabled: false }])
      return 'sent'
    }) as never)
    await runOneTick()
    const sessions = mockSendPrompt.mock.calls.map(c => (c as unknown[])[0])
    expect(sessions).toContain('retry-test-session')
    expect(sessions).not.toContain('plain-session')
  })

  it('the retry is cancelled during the pre-check -> no fire, and the row is not touched again', async () => {
    duringPreCheck = () => { mockGetPendingRetry.mockReturnValue(undefined) }
    await runOneTick()
    expect(preCheckRuns).toBeGreaterThan(0)
    expect(fired()).toBe(false)
    expect(mockUpdatePendingRetry).not.toHaveBeenCalled()
  })
})
