import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => true)
const mockIsReady = vi.fn(() => false)
const mockClearModal = vi.fn(() => false)
const mockSendPrompt = vi.fn()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  // Keep the telegram wake watcher off so this test stays isolated to the
  // router's own refusal branch.
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return []
    return mockGetPendingMessages()
  },
  // The router re-reads the row's status immediately before sending (the tick
  // works from a snapshot taken at its start). Pending here keeps these
  // fixtures on the delivery path they were written to measure.
  getMessageStatus: (..._a: unknown[]) => 'pending',
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
  // Forward-compatible: this mock declares an EXPLICIT export list, so any db
  // helper a future router path calls has to appear here or the module resolves
  // it as undefined and the tick dies silently -- the delivery simply never
  // happens and the assertion reads as "spy called 0 times".
  // Added ahead of #1104 (superseded-message marking), whose router path calls
  // this helper. Nothing reads the value until that lands; until then it is an
  // unused key, which is why this is safe to ship on its own.
  countNewerMessagesFromSameSender: (..._a: unknown[]) => 0,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  isKnownAgent: () => true,
  // The wrap step reads the sender's channel for the area-agent label (e349287f); no sender here owns one.
  readAgentChannelProvider: () => null,
  agentDir: () => '/tmp/none-agentdir',
  // These cases are about the KEYBOARD path (modal cleared -> prompt delivered),
  // so the agent under test is deliberately NOT a worksource agent: a queue
  // agent skips the readiness gate entirely, which would stop this file from
  // measuring the refusal branch it exists to pin.
  readAgentWorksourceChannel: () => false,
  readAgentPullDelivery: () => false,
}))

vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
  clearFeedbackModalAndRecheck: vi.fn((...a: unknown[]) => mockClearModal(...(a as []))),
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn((...a: unknown[]) => mockIsReady(...(a as []))),
  clearStaleParkedInput: vi.fn(() => false),
  capturePane: vi.fn(() => ''),
  sendPromptToSession: vi.fn((...a: unknown[]) => mockSendPrompt(...(a as []))),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

import { runMessageRouterTick } from '../web/message-router.js'

import { logger } from '../logger.js'
import { isSessionReadyForPrompt, clearFeedbackModalAndRecheck, clearStaleParkedInput, sendPromptToSession } from '../web/agent-process.js'

vi.mock('../web/agent-message-wrap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-message-wrap.js')>()),
  classifyAgentMessage: (from: string) => ({ category: 'trusted-peer', safeFrom: from }),
}))

function row(id: number, to: string, ageMs = 0, priority = 0) {
  return {
    id, from_agent: 'peer', to_agent: to, content: `message ${id}`,
    created_at: Math.floor((Date.now() - ageMs) / 1000), status: 'pending',
    urgent: 0, stop_authorized: 0, priority, affects_current_work: null,
  }
}

describe('message router skips repeated busy recipients within one tick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockIsReady.mockReturnValue(false)
    mockClearModal.mockReturnValue(false)
    vi.mocked(clearStaleParkedInput).mockResolvedValue(false)
  })

  it('checks five fresh rows for dex once and logs every id once', async () => {
    const rows = [101, 102, 103, 104, 105].map(id => row(id, 'dex'))
    mockGetPendingMessages.mockReturnValue(rows)
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(clearFeedbackModalAndRecheck).toHaveBeenCalledTimes(1)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(0)
    expect(sendPromptToSession).toHaveBeenCalledTimes(0)
    const warnings = vi.mocked(logger.warn).mock.calls.filter(
      call => call[1] === 'Agent message target session busy, will retry',
    )
    expect(warnings).toHaveLength(5)
    expect(warnings.map(call => call[0])).toEqual(rows.map(msg => ({ id: msg.id, to: 'dex', session: 'agent-dex' })))
  })

  it('checks each of two interleaved busy recipients once', async () => {
    mockGetPendingMessages.mockReturnValue([
      ...[201, 202, 203].map(id => row(id, 'dex-interleaved')),
      ...[204, 205, 206].map(id => row(id, 'rex-interleaved')),
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(2)
    expect(isSessionReadyForPrompt).toHaveBeenNthCalledWith(1, 'agent-dex-interleaved', null)
    expect(isSessionReadyForPrompt).toHaveBeenNthCalledWith(2, 'agent-rex-interleaved', null)
  })

  it('tries the janitor once when old rows follow a young high row', async () => {
    mockGetPendingMessages.mockReturnValue([row(301, 'dex-old', 10_000, 1), row(302, 'dex-old', 120_000), row(303, 'dex-old', 120_000)])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(1)
  })

  it('checks again after the memo janitor clears parked input', async () => {
    vi.mocked(clearStaleParkedInput).mockResolvedValueOnce(true)
    mockGetPendingMessages.mockReturnValue([
      row(401, 'dex-cleared', 10_000, 1), row(402, 'dex-cleared', 120_000), row(403, 'dex-cleared'),
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(2)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(1)
  })

  it('checks an unblock row from orin after an ordinary busy row', async () => {
    mockGetPendingMessages.mockReturnValue([
      row(501, 'dex-unblock'),
      { ...row(502, 'dex-unblock'), from_agent: 'orin', affects_current_work: 'unblocks' },
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(2)
  })

  it('does not memoize a row whose feedback modal was cleared', async () => {
    mockClearModal.mockReturnValueOnce(true)
    mockGetPendingMessages.mockReturnValue([601, 602, 603].map(id => row(id, 'dex-modal')))
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(2)
    expect(clearFeedbackModalAndRecheck).toHaveBeenCalledTimes(2)
  })

  it('checks the same busy recipient again on the next tick', async () => {
    mockGetPendingMessages.mockReturnValue([701, 702, 703].map(id => row(id, 'dex-next-tick')))
    await runMessageRouterTick()
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(2)
    const warnings = vi.mocked(logger.warn).mock.calls.filter(call => call[1] === 'Agent message target session busy, will retry')
    expect(warnings).toHaveLength(3)
  })

  it('tries the janitor once per recipient per tick when every row is old', async () => {
    // three rows for one busy recipient, all older than JANITOR_PARKED_MIN_AGE_MS (45 s)
    mockGetPendingMessages.mockReturnValue([801, 802, 803].map(id => row(id, 'dex-all-old', 120_000)))
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(1)
  })

  it('checks the next row fully after a bypassing row cleared the modal of a memoized recipient', async () => {
    // A ordinary young -> memo; B unblock from orin -> full check, modal cleared; C ordinary young -> must be checked
    mockClearModal.mockReturnValueOnce(false).mockReturnValueOnce(true)
    mockGetPendingMessages.mockReturnValue([
      row(901, 'dex-bypass-modal'),
      { ...row(902, 'dex-bypass-modal'), from_agent: 'orin', affects_current_work: 'unblocks' },
      row(903, 'dex-bypass-modal'),
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(3)
  })

  it('keeps the janitor attempt when a bypassing row re-memoizes the recipient', async () => {
    // A ordinary young -> memo(false); B ordinary old -> memo janitor (true); C unblock young -> full check, busy end;
    // D ordinary old -> must be skipped, not a second janitor
    mockGetPendingMessages.mockReturnValue([
      row(1001, 'dex-bypass-janitor'),
      row(1002, 'dex-bypass-janitor', 120_000),
      { ...row(1003, 'dex-bypass-janitor'), from_agent: 'orin', affects_current_work: 'unblocks' },
      row(1004, 'dex-bypass-janitor', 120_000),
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(2)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(1)
  })

  it('keeps the janitor attempt across a bypassing row that cleared the modal', async () => {
    // A young -> memo; B old -> memo janitor fails; C unblock young -> full check, modal cleared, no memo;
    // D young -> full check, busy, re-memo; E old -> must be skipped, not a second janitor
    mockClearModal.mockReturnValueOnce(false).mockReturnValueOnce(true)
    mockGetPendingMessages.mockReturnValue([
      row(1101, 'dex-janitor-history'),
      row(1102, 'dex-janitor-history', 120_000),
      { ...row(1103, 'dex-janitor-history'), from_agent: 'orin', affects_current_work: 'unblocks' },
      row(1104, 'dex-janitor-history'),
      row(1105, 'dex-janitor-history', 120_000),
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(3)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(1)
  })

  it('keeps the janitor attempt after the memo janitor cleared parked input', async () => {
    // A young -> memo; B old -> memo janitor clears (memo deleted); C young -> full check, busy, re-memo;
    // D old -> must be skipped, not a second janitor
    vi.mocked(clearStaleParkedInput).mockResolvedValueOnce(true)
    mockGetPendingMessages.mockReturnValue([
      row(1201, 'dex-janitor-cleared'),
      row(1202, 'dex-janitor-cleared', 120_000),
      row(1203, 'dex-janitor-cleared'),
      row(1204, 'dex-janitor-cleared', 120_000),
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(2)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(1)
  })

  it('keeps a full-path janitor attempt across a bypassing row that cleared the modal', async () => {
    // A old -> full check, janitor fails, memo; B unblock young -> full check, modal cleared, no memo;
    // C young -> full check, busy, re-memo; D old -> must be skipped, not a second janitor
    mockClearModal.mockReturnValueOnce(false).mockReturnValueOnce(true)
    mockGetPendingMessages.mockReturnValue([
      row(1301, 'dex-full-janitor', 120_000),
      { ...row(1302, 'dex-full-janitor'), from_agent: 'orin', affects_current_work: 'unblocks' },
      row(1303, 'dex-full-janitor'),
      row(1304, 'dex-full-janitor', 120_000),
    ])
    await runMessageRouterTick()
    expect(isSessionReadyForPrompt).toHaveBeenCalledTimes(3)
    expect(clearStaleParkedInput).toHaveBeenCalledTimes(1)
  })
})
