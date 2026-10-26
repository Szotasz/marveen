import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import type { TeamsCreds } from '../teams-send.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { toPendingRetryView } from '../pending-retries.js'
import {
  notifyTaskTargetOfStall,
  sendPendingRetryMainAgentNotice,
  resolveTaskChannelTarget,
  type BoundChannel,
} from '../web/schedule-runner.js'

// Teams stall notice for a stuck scheduled task (notifyTaskTargetOfStall in
// web/schedule-runner.ts). Stage 1 of the pending-retry alerting told only the
// main agent; the team whose agent could not start -- the people waiting for
// the scheduled result in their Teams channel -- learned nothing, so a late
// result looked like a forgotten one.
//
// What this pins:
//   * the notice is addressed to the STUCK ROW's agent, not task.agent;
//   * non-Teams targets and target-less tasks are skipped without a send;
//   * a failed send resolves 'failed' instead of rejecting, and never leaks
//     the bot secret into a log line;
//   * stage 1 fires it only when the alert claim was won AND the main-agent
//     message landed -- a lost race or a DB error must not reach Teams.
//
// src/web/agent-scaffold.ts is not part of this checkout, so BOTH of its
// importers are mocked here (agent-process.js and heartbeat-metrics-inject.js):
// loading either would fail the whole suite on the missing module.

const mockSendTeamsMessage = vi.fn(
  async (_creds: TeamsCreds = CREDS, _stateDir = '', _conversationId = '', _text = '') => ({ status: 201, messageId: 'm-1' }),
)
const mockMarkPendingTaskRetryAlert = vi.fn((): boolean => true)
const mockClearPendingTaskRetryAlert = vi.fn()
const mockCreateAgentMessage = vi.fn()
const mockListScheduledTasks = vi.fn((): ScheduledTask[] => [])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../teams-send.js', () => ({
  // Only the sink this suite cares about; the real module is covered by
  // teams-dashboard-send.test.ts.
  sendTeamsMessage: (...a: unknown[]) => mockSendTeamsMessage(...(a as [])),
}))

// The runner persists its last-run map to store/schedule-last-run.json; stub
// the writer so the suite never touches the operator's real store.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn(),
  listPendingTaskRetries: () => [] as unknown[],
  getPendingTaskRetry: vi.fn(),
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: (...a: unknown[]) => mockMarkPendingTaskRetryAlert(...(a as [])),
  clearPendingTaskRetryAlert: (...a: unknown[]) => mockClearPendingTaskRetryAlert(...(a as [])),
  markPendingTaskRetryOwnerAlert: vi.fn(() => false),
  clearPendingTaskRetryOwnerAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...(a as [])),
}))

// channelStateDir and readTeamsCreds must stay REAL: the suite pins the state
// directory and the .env lookup the runner hands them. Only the provider's own
// sends are neutralized, as in schedule-runner-retry-missing.test.ts.
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

vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-teams-stall-notice-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

// Second importer of the withheld agent-scaffold.ts -- mocked for the same
// reason as agent-process.js above.
vi.mock('../web/heartbeat-metrics-inject.js', () => ({
  collectHeartbeatMetricsBlock: vi.fn(() => ''),
}))

// -- fixtures --------------------------------------------------------------

const CONVERSATION = '19:conv@thread.tacv2'
const CREDS: TeamsCreds = { appId: 'app-1', secret: 'sec-1', tenant: 'tenant-1' }
/** The task definition notifyTaskTargetOfStall reads (name, agent, delivery pin). */
type StallTask = Parameters<typeof notifyTaskTargetOfStall>[0]
/** The narrower shape resolveTaskChannelTarget itself takes (no task name). */
type StallTaskArg = Parameters<typeof resolveTaskChannelTarget>[0]

function teamsTask(overrides: Partial<StallTask> = {}): StallTask {
  return {
    name: 'napi-riport',
    agent: 'teamsagent',
    telegramChatId: CONVERSATION,
    channelProvider: 'teams',
    ...overrides,
  }
}

function teamsTarget(chatId: string | null, ambiguousCandidates?: number): BoundChannel {
  return chatId === null
    ? { provider: 'teams', chatId: null, ...(ambiguousCandidates ? { ambiguousCandidates } : {}) }
    : { provider: 'teams', chatId }
}

/** A pending row two hours old: past ALERT_THRESHOLD_MS, so stage 1 applies. */
function pendingView(now = Date.now(), agentName = 'teamsagent') {
  return toPendingRetryView(
    {
      id: 1,
      task_name: 'napi-riport',
      agent_name: agentName,
      first_attempt: now - 2 * 60 * 60_000,
      last_attempt: now,
      attempt_count: 3,
      last_reason: 'busy',
      alert_sent_at: null,
      owner_alert_sent_at: null,
    },
    now,
  )
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

// -- unit: notifyTaskTargetOfStall -----------------------------------------

describe('notifyTaskTargetOfStall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps implementations: without this, the throwing
    // createAgentMessage of one case leaks into the next.
    mockCreateAgentMessage.mockReset()
    mockMarkPendingTaskRetryAlert.mockReturnValue(true)
  })

  it("sends to the stuck agent's own Teams conversation and reads its .env", async () => {
    const resolveTarget = vi.fn((_task: StallTaskArg) => teamsTarget(CONVERSATION))
    const readCreds = vi.fn((_fallbackAppId: string, _files?: string[]) => CREDS)
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    const outcome = await notifyTaskTargetOfStall(teamsTask(), 'teamsagent', 75, { resolveTarget, send, readCreds })

    expect(outcome).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    const [sentCreds, stateDir, conversationId, text] = send.mock.calls[0]
    expect(sentCreds).toBe(CREDS)
    expect(conversationId).toBe(CONVERSATION)
    expect(text).toContain('napi-riport')
    // The STUCK agent's channel state dir (path.sep-agnostic: the last five
    // segments are agents/<agent>/.claude/channels/teams).
    expect(stateDir.split(/[\\/]/).slice(-5).join('/')).toBe('agents/teamsagent/.claude/channels/teams')
    // The bot credentials come from that same directory's .env, and nowhere else.
    expect(readCreds).toHaveBeenCalledTimes(1)
    expect(readCreds).toHaveBeenCalledWith('', [join(stateDir, '.env')])
  })

  it('reads the install-scoped Teams config for the main agent', async () => {
    const resolveTarget = vi.fn((_task: StallTaskArg) => teamsTarget('19:main@thread.tacv2'))
    const readCreds = vi.fn((_fallbackAppId: string, _files?: string[]) => CREDS)
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    const outcome = await notifyTaskTargetOfStall(
      teamsTask({ agent: MAIN_AGENT_ID, telegramChatId: '19:main@thread.tacv2' }),
      MAIN_AGENT_ID,
      90,
      { resolveTarget, send, readCreds },
    )

    expect(outcome).toBe('sent')
    // No agent-scoped .env candidate list: the main agent's credentials are
    // resolved by readTeamsCreds' own install-level defaults.
    expect(readCreds).toHaveBeenCalledTimes(1)
    expect(readCreds).toHaveBeenCalledWith('', undefined)
  })

  it('resolves the target for the stuck row agent, not task.agent', async () => {
    const resolveTarget = vi.fn((_task: StallTaskArg) => teamsTarget(CONVERSATION))
    const readCreds = vi.fn((_fallbackAppId: string, _files?: string[]) => CREDS)
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    await notifyTaskTargetOfStall(teamsTask({ agent: 'x' }), 'teamsagent', 30, { resolveTarget, send, readCreds })

    expect(resolveTarget).toHaveBeenCalledTimes(1)
    expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({ agent: 'teamsagent' }))
    expect(resolveTarget.mock.calls[0][0].agent).not.toBe('x')
  })

  it("skips a non-Teams target with 'not-teams'", async () => {
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    const outcome = await notifyTaskTargetOfStall(teamsTask({ channelProvider: 'telegram' }), 'teamsagent', 30, {
      resolveTarget: () => ({ provider: 'telegram', chatId: '42' }),
      send,
    })

    expect(outcome).toBe('not-teams')
    expect(send).not.toHaveBeenCalled()
  })

  it("skips a Teams target with no chat id: 'no-target', no send, one info line", async () => {
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    const outcome = await notifyTaskTargetOfStall(teamsTask({ telegramChatId: undefined }), 'teamsagent', 30, {
      resolveTarget: () => teamsTarget(null),
      send,
    })

    expect(outcome).toBe('no-target')
    expect(send).not.toHaveBeenCalled()
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info).mock.calls[0][0]).toMatchObject({ reason: 'unbound' })
  })

  it("names an opted-out task ('none') as the reason", async () => {
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    const outcome = await notifyTaskTargetOfStall(teamsTask({ telegramChatId: 'none' }), 'teamsagent', 30, {
      resolveTarget: () => teamsTarget(null),
      send,
    })

    expect(outcome).toBe('no-target')
    expect(send).not.toHaveBeenCalled()
    expect(vi.mocked(logger.info).mock.calls[0][0]).toMatchObject({ reason: 'opted-out' })
  })

  it('reports the ambiguity count when the target is an unpinned 2+ contact binding', async () => {
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    const outcome = await notifyTaskTargetOfStall(teamsTask({ telegramChatId: undefined }), 'teamsagent', 30, {
      resolveTarget: () => teamsTarget(null, 2),
      send,
    })

    expect(outcome).toBe('no-target')
    expect(send).not.toHaveBeenCalled()
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info).mock.calls[0][0]).toMatchObject({ task: 'napi-riport', agent: 'teamsagent', reason: 'ambiguous', ambiguousCandidates: 2 })
  })

  it("resolves 'failed' on a send error, logs the message only, and never leaks the secret", async () => {
    const secretCreds: TeamsCreds = { appId: 'app-9', secret: 'SECRET-XYZ-123', tenant: 't-9' }
    const readCreds = vi.fn((_fallbackAppId: string, _files?: string[]) => secretCreds)
    const send = vi.fn(async () => {
      throw new Error('Teams API 403: Forbidden')
    })

    const outcome = await notifyTaskTargetOfStall(teamsTask(), 'teamsagent', 45, {
      resolveTarget: () => teamsTarget(CONVERSATION),
      send,
      readCreds,
    })

    expect(outcome).toBe('failed')
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatchObject({ error: 'Teams API 403: Forbidden' })
    // Neither the creds object nor any of its fields may reach a log line.
    for (const level of [logger.info, logger.warn, logger.debug, logger.error]) {
      for (const call of vi.mocked(level).mock.calls) {
        for (const arg of call) expect(JSON.stringify(arg)).not.toContain('SECRET-XYZ-123')
      }
    }
  })

  it("resolves 'failed' when the target cannot even be resolved", async () => {
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )
    const resolveTarget = vi.fn((_task: StallTaskArg) => {
      throw new Error('access.json unreadable')
    })

    const outcome = await notifyTaskTargetOfStall(teamsTask(), 'teamsagent', 30, { resolveTarget, send })

    expect(outcome).toBe('failed')
    expect(send).not.toHaveBeenCalled()
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
  })

  it('writes a team-facing line: the task, the agent and the age, no operator detail', async () => {
    const send = vi.fn(
      async (_creds: TeamsCreds, _stateDir: string, _conversationId: string, _text: string) => ({ status: 201 }),
    )

    await notifyTaskTargetOfStall(teamsTask(), 'teamsagent', 75, {
      resolveTarget: () => teamsTarget(CONVERSATION),
      send,
      readCreds: () => CREDS,
    })

    const text = send.mock.calls[0][3]
    expect(text).toContain('napi-riport')
    expect(text).toContain('75 perce')
    // The recipients are the humans waiting for the result, not the operator
    // who has to fix the session.
    expect(text).not.toMatch(/tmux|MCP|Ütemezések|dashboard|belép/i)
  })
})

// -- integration: stage 1 of the pending-retry alerting ---------------------

describe('sendPendingRetryMainAgentNotice: Teams stall notice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps implementations: without this, the throwing
    // createAgentMessage of one case leaks into the next.
    mockCreateAgentMessage.mockReset()
    mockMarkPendingTaskRetryAlert.mockReturnValue(true)
  })

  it('notifies the task Teams target once the main-agent notice landed', async () => {
    const now = Date.now()
    sendPendingRetryMainAgentNotice(pendingView(now), now, teamsTask())
    await flushPromises()

    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    expect(mockSendTeamsMessage).toHaveBeenCalledTimes(1)
    expect(mockSendTeamsMessage.mock.calls[0][2]).toBe(CONVERSATION)
    // The row's real age (pendingView: two hours), not a stand-in.
    expect(String(mockSendTeamsMessage.mock.calls[0][3])).toContain('120 perce')
    expect(mockClearPendingTaskRetryAlert).not.toHaveBeenCalled()
  })

  it('keeps the alert claim when the Teams send fails', async () => {
    const now = Date.now()
    mockSendTeamsMessage.mockRejectedValueOnce(new Error('Teams API 503: unavailable'))
    sendPendingRetryMainAgentNotice(pendingView(now), now, teamsTask())
    await flushPromises()

    expect(mockSendTeamsMessage).toHaveBeenCalledTimes(1)
    // A failed Teams send is the notice's own business: it must never roll
    // back the alert claim that was already made.
    expect(mockClearPendingTaskRetryAlert).not.toHaveBeenCalled()
    expect(vi.mocked(logger.warn).mock.calls.map(c => c[1])).toContain('Teams stall notice failed')
  })

  it('sends nothing when the alert claim was lost to a racing tick', async () => {
    const now = Date.now()
    mockMarkPendingTaskRetryAlert.mockReturnValue(false)
    sendPendingRetryMainAgentNotice(pendingView(now), now, teamsTask())
    await flushPromises()

    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    expect(mockSendTeamsMessage).not.toHaveBeenCalled()
  })

  it('sends nothing and clears the stamp when the main-agent message fails', async () => {
    const now = Date.now()
    mockCreateAgentMessage.mockImplementation(() => {
      throw new Error('db locked')
    })
    sendPendingRetryMainAgentNotice(pendingView(now), now, teamsTask())
    await flushPromises()

    expect(mockSendTeamsMessage).not.toHaveBeenCalled()
    expect(mockClearPendingTaskRetryAlert).toHaveBeenCalledTimes(1)
    expect(mockClearPendingTaskRetryAlert).toHaveBeenCalledWith('napi-riport', 'teamsagent')
  })

  it('sends nothing without a task definition (the legacy two-argument call)', async () => {
    const now = Date.now()
    sendPendingRetryMainAgentNotice(pendingView(now), now)
    await flushPromises()

    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    // The main-agent message landed: the skip is down to the missing task.
    expect(mockCreateAgentMessage.mock.results[0].type).toBe('return')
    expect(mockSendTeamsMessage).not.toHaveBeenCalled()
  })
})
