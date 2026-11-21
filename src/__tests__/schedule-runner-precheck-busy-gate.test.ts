import { allowTargetSessionsForTest } from './helpers/allow-target-sessions.js'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// PRECHECKBUSY1119 (B-1119-C01). The cron loop ran a task's pre-check FIRST and
// dropped a skipIfBusy tick for a busy agent only AFTER the fire attempt. A
// pre-check that advances its own state (nav-adategeszseg: starts the next
// measurement and marks the finding "already reported") then loses its finding
// on every tick that is dropped: the next tick reads "already reported".
// Now a skipIfBusy task with a pre-check asks "is the target busy?" first, and
// the pre-check does not run for a busy target.
//
// The pre-check here is a real script run by the real tick; it appends one line
// per run to a file, so "did the pre-check run" is a line count, not a mock.

const mockAppendTaskRun = vi.fn()
const mockInsertRetry = vi.fn()
const mockSendPrompt = vi.fn((..._a: unknown[]) => 'sent')
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])
let ready = true
let pane: string | null = null
let firstRunGate = false
let modalClears = false
let feedbackModal = false
const mockClearModal = vi.fn(() => modalClears)

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
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => [],
  getPendingTaskRetry: () => undefined,
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: (...a: unknown[]) => mockInsertRetry(...a),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))
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
  SCHEDULED_TASKS_DIR: '/tmp/marveen-precheck-busy-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))
vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
  clearFeedbackModalAndRecheck: () => mockClearModal(),
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => ready,
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => pane,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))
vi.mock('../pane-state.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../pane-state.js')>()
  return {
    ...real,
    detectsFirstRunGate: (p: string) => (firstRunGate ? 'folder-trust' : real.detectsFirstRunGate(p)),
    detectsFeedbackDraftModal: (p: string) => (feedbackModal || real.detectsFeedbackDraftModal(p)),
  }
})

const dir = mkdtempSync(join(tmpdir(), 'precheck-busy-'))
const scriptPath = join(dir, 'pre-check.sh')
const runLog = join(dir, 'runs.log')
writeFileSync(scriptPath, `#!/usr/bin/env bash\necho ran >> "${runLog}"\necho "finding"\n`, { mode: 0o755 })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function preCheckRuns(): number {
  return existsSync(runLog) ? readFileSync(runLog, 'utf8').split('\n').filter(Boolean).length : 0
}

const TASK: ScheduledTask = {
  name: 'precheck-busy-hb',
  description: 'skipIfBusy pre-check fixture',
  prompt: 'Check the thing.',
  schedule: '* * * * *',
  agent: 'busyagent',
  enabled: true,
  createdAt: 0,
  type: 'heartbeat',
  targetSession: 'precheck-busy-session',
  preCheck: scriptPath,
  skipIfBusy: true,
}

async function until(cond: () => boolean, ms = 6_000): Promise<void> {
  const t0 = performance.now()
  while (!cond() && performance.now() - t0 < ms) await new Promise<void>((r) => setImmediate(r))
}

async function runOneTick(done: () => boolean) {
  vi.resetModules()
  const { startScheduleRunner, resetPreCheckAnswersForTests } = await import('../web/schedule-runner.js')
  resetPreCheckAnswersForTests()
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(5_001)
  await until(done)
  // let the rest of the tick finish after the condition
  await until(() => false, 500)
  clearInterval(stop)
}

const runsOf = () => mockAppendTaskRun.mock.calls.filter(c => c[0] === TASK.name).map(c => c[2])

describe('a skipIfBusy task does not run its pre-check for a busy target (PRECHECKBUSY1119)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rmSync(runLog, { force: true })
    ready = true
    pane = null
    firstRunGate = false
    modalClears = false
    feedbackModal = false
    mockSendPrompt.mockImplementation(() => 'sent')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-07-31T06:00:30.000Z'))
    mockListScheduledTasks.mockReturnValue([{ ...TASK }])
  })
  afterEach(() => { vi.useRealTimers() })

  it('busy target: the pre-check does NOT run, the tick is recorded as skipped, nothing is sent or queued', async () => {
    ready = false
    await runOneTick(() => mockAppendTaskRun.mock.calls.length > 0)
    expect(preCheckRuns()).toBe(0)
    expect(runsOf()).toEqual(['skipped'])
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockInsertRetry).not.toHaveBeenCalled()
  })

  it('free target: the pre-check runs once and its finding reaches the prompt', async () => {
    await runOneTick(() => mockSendPrompt.mock.calls.length > 0)
    expect(preCheckRuns()).toBe(1)
    expect(String(mockSendPrompt.mock.calls[0][1])).toContain('finding')
  })

  it('control: skipIfBusy=false and busy -> the pre-check still runs and the tick is queued (old path)', async () => {
    ready = false
    mockListScheduledTasks.mockReturnValue([{ ...TASK, skipIfBusy: false }])
    await runOneTick(() => mockInsertRetry.mock.calls.length > 0)
    expect(preCheckRuns()).toBe(1)
    expect(mockInsertRetry.mock.calls[0][3]).toBe('busy')
  })

  it('control: forceSend is exempt -> the pre-check runs even for a not-ready pane', async () => {
    ready = false
    mockListScheduledTasks.mockReturnValue([{ ...TASK, forceSend: true }])
    await runOneTick(() => preCheckRuns() > 0)
    expect(preCheckRuns()).toBe(1)
  })

  it('a first-run dialog is not "busy": the pre-check runs and the task keeps its own first-run path', async () => {
    ready = false
    pane = 'dialog'
    firstRunGate = true
    await runOneTick(() => mockInsertRetry.mock.calls.length > 0)
    expect(preCheckRuns()).toBe(1)
    expect(mockInsertRetry.mock.calls[0][3]).toBe('first-run')
  })

  it('a pane held only by the feedback modal counts as free; the modal is dismissed once, by the fire attempt', async () => {
    ready = false
    pane = 'modal'
    feedbackModal = true
    modalClears = true
    await runOneTick(() => mockSendPrompt.mock.calls.length > 0)
    expect(preCheckRuns()).toBe(1)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockClearModal).toHaveBeenCalledTimes(1)
  })

  it('the probe itself types nothing: a busy pane is dropped without a modal-dismissal attempt', async () => {
    ready = false
    pane = 'busy pane'
    await runOneTick(() => mockAppendTaskRun.mock.calls.length > 0)
    expect(runsOf()).toEqual(['skipped'])
    expect(mockClearModal).not.toHaveBeenCalled()
  })
})

// OWNEREXEC1109: the runner types only into fleet sessions (helpers/allow-target-sessions.ts).
allowTargetSessionsForTest(['precheck-busy-session'])
