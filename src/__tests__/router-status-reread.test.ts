// RED PROBE: a row whose status changes AFTER the tick started must not be
// delivered from the tick's stale snapshot.
//
// The router reads every pending row into an array at the start of a tick and
// then works from that in-memory copy. Nothing re-reads the row before the
// actual send, so any status change made while the tick is running -- a sender
// closing its own queued message, an operator fixing a row by hand, anything --
// is invisible to the delivery loop: the message goes out anyway. With up to
// MAX_MESSAGES_PER_TICK rows processed serially, and each send taking seconds
// (chunked typing plus the idle gate), the blind window is the whole tick, not
// an instant.
//
// This is the precondition for any form of revocation: a sender that cannot
// stop an undelivered message inside that window cannot stop it at all. It also
// stands on its own -- the one partial route that exists today (closing a row
// via PUT /api/messages/:id) is silently defeated by the same snapshot.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)
// The live status of each row, as the DB would answer it RIGHT NOW -- the test
// mutates this mid-tick to model a change landing while the tick runs.
const liveStatus = new Map<number, string | null>()
const mockGetMessageStatus = vi.fn((id: number) => liveStatus.get(id) ?? null)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query of the reconnect pre-pass
    return mockGetPendingMessages()
  },
  getMessageStatus: (id: number) => mockGetMessageStatus(id),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  countNewerMessagesFromSameSender: (..._a: unknown[]) => 0,
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentWorksourceChannel: () => false,
  readAgentPullDelivery: () => false,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (..._a: unknown[]) => true,
  capturePane: (..._a: unknown[]) => '',
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'payload' }),
}))

vi.mock('../web/telegram-inbox-wake.js', () => ({
  maybeWakeSubAgentsForTelegram: vi.fn(),
}))

import { runMessageRouterTick } from '../web/message-router.js'

function pendingRows(ids: number[]) {
  const nowSec = Math.floor(Date.now() / 1000)
  return ids.map((id) => ({
    id,
    from_agent: 'orin',
    to_agent: 'dex', // sub-agent -> tmux-inject path (the main agent PULLs)
    content: `payload ${id}`,
    created_at: nowSec,
    origin_note: null,
    trace_id: null,
    span_id: null,
  }))
}

function snapshot(ids: number[]) {
  liveStatus.clear()
  for (const id of ids) liveStatus.set(id, 'pending')
  mockGetPendingMessages.mockReturnValue(pendingRows(ids))
}

const deliveredIds = () => mockSendPrompt.mock.calls.map((_c, i) => mockMarkDelivered.mock.calls[i]?.[0])

describe('message router: the row is re-read before it is delivered', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    liveStatus.clear()
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
  })

  it('does not deliver a row closed while the tick was running', async () => {
    snapshot([401, 402, 403])
    // The change lands DURING the tick: closing 403 while 401 is being typed is
    // exactly the live sequence -- a send takes seconds, the tick takes longer.
    mockSendPrompt.mockImplementation(async (...a: unknown[]) => {
      if (String(a[1] ?? '').length >= 0 && mockSendPrompt.mock.calls.length === 1) {
        liveStatus.set(403, 'failed')
      }
      return 'sent' as const
    })

    await runMessageRouterTick()

    // 401 and 402 go out; 403 must not -- its row is no longer pending.
    expect(mockSendPrompt).toHaveBeenCalledTimes(2)
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([401, 402])
    // And it must not be re-closed either: the row already has a terminal state
    // and a reason; overwriting it would erase who closed it and why.
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('does not deliver a row that vanished from the table mid-tick', async () => {
    snapshot([501])
    liveStatus.set(501, null) // deleted between the snapshot and the send

    await runMessageRouterTick()

    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: an untouched pending row still goes out normally', async () => {
    // Without this, a re-read that rejected EVERYTHING would pass the two
    // assertions above while silently stopping all delivery.
    snapshot([601, 602])

    await runMessageRouterTick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(2)
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([601, 602])
    expect(mockGetMessageStatus).toHaveBeenCalled()
  })

  it('re-reads ONE row per delivery, not the whole table', async () => {
    // The cost bound: the re-read must stay a single keyed lookup per message
    // actually being delivered. A scan here would show up as extra calls.
    snapshot([701, 702, 703])

    await runMessageRouterTick()

    expect(mockGetMessageStatus).toHaveBeenCalledTimes(3)
    expect(mockGetMessageStatus.mock.calls.map((c) => c[0])).toEqual([701, 702, 703])
  })
})
