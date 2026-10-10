// ROUTERSAWTURN824 BINDING: the router must hand every keyboard (tmux)
// delivery to the post-delivery transcript check -- after the row is marked
// delivered, with the head row and its batch mates, and never for a send that
// threw or for a channel-inbound row (no envelope msg_id to look for). The
// check's own behaviour is pinned in delivery-turn-check.test.ts; this file
// pins only that the router CALLS it, in the right place and shape.
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
  // 'tg' models a channel-inbound row (a user message, no envelope msg_id).
  classifyAgentMessage: (from: string) => (from === 'tg'
    ? { category: 'channel-inbound', safeFrom: 'tg' }
    : { category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: (_c: string, _s: string, _f: string, _content: string, id?: number) =>
    ({ prefix: `[env msg_id:${id}]`, wrapped: 'payload' }),
}))

// Batching is off unless a test turns it on for 'dex'.
const batchCap = { value: 0 }
vi.mock('../web/batch-inject.js', () => ({
  batchInjectCapFor: () => batchCap.value,
  composeBatchInjection: (items: { prefix: string; wrapped: string }[]) => items.map((i) => i.prefix + i.wrapped).join('\n'),
}))

const mockScheduleTurnCheck = vi.fn((..._a: unknown[]) => undefined)
vi.mock('../web/delivery-turn-check.js', () => ({
  scheduleDeliveryTurnCheck: (...a: unknown[]) => mockScheduleTurnCheck(...a),
}))

vi.mock('../web/telegram-inbox-wake.js', () => ({
  maybeWakeSubAgentsForTelegram: vi.fn(),
}))

import { runMessageRouterTick } from '../web/message-router.js'

function row(id: number, from = 'orin') {
  return {
    id, from_agent: from, to_agent: 'dex', content: `payload ${id}`,
    created_at: Math.floor(Date.now() / 1000), origin_note: null, trace_id: null, span_id: null,
  }
}
function snapshot(rows: ReturnType<typeof row>[]) {
  liveStatus.clear()
  for (const r of rows) liveStatus.set(r.id, 'pending')
  mockGetPendingMessages.mockReturnValue(rows)
}

describe('message router -> delivery turn check binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    batchCap.value = 0
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
  })

  it('schedules one check per tmux delivery, after marking it delivered, with the send start time', async () => {
    snapshot([row(801)])
    const before = Date.now()
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockScheduleTurnCheck).toHaveBeenCalledTimes(1)
    const arg = mockScheduleTurnCheck.mock.calls[0][0] as { toAgent: string; msgIds: number[]; sentAtMs: number; host: string | null }
    expect(arg.toAgent).toBe('dex')
    expect(arg.msgIds).toEqual([801])
    expect(arg.host).toBeNull()
    expect(arg.sentAtMs).toBeGreaterThanOrEqual(before)
    expect(arg.sentAtMs).toBeLessThanOrEqual(Date.now())
    // Order: the check is scheduled only once the row says 'delivered'.
    expect(mockMarkDelivered.mock.invocationCallOrder[0]).toBeLessThan(mockScheduleTurnCheck.mock.invocationCallOrder[0])
  })

  it('a multi-envelope batch is checked as one request carrying the head and every mate', async () => {
    batchCap.value = 5
    snapshot([row(811), row(812), row(813)])
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockScheduleTurnCheck).toHaveBeenCalledTimes(1)
    expect((mockScheduleTurnCheck.mock.calls[0][0] as { msgIds: number[] }).msgIds).toEqual([811, 812, 813])
  })

  it('a send that threw schedules no check (the row is not delivered)', async () => {
    snapshot([row(821)])
    mockSendPrompt.mockImplementation(async () => { throw new Error('tmux gone') })
    await runMessageRouterTick()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockScheduleTurnCheck).not.toHaveBeenCalled()
  })

  it('a channel-inbound row is not checked (it carries no envelope msg_id)', async () => {
    snapshot([row(831, 'tg')])
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockScheduleTurnCheck).not.toHaveBeenCalled()
  })
})
