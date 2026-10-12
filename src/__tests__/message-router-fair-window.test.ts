// fc5748f5: the router tick evaluates a FAIR window of pending rows, not the
// globally oldest MAX_MESSAGES_PER_TICK. Two levels: the pure window selection,
// and one real tick in which an idle recipient's message sits behind a busy
// recipient's older backlog.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)
const liveStatus = new Map<number, string | null>()

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
    const all = mockGetPendingMessages() as Array<{ id: number; to_agent: string }>
    return toAgent ? all.filter((r) => r.to_agent === toAgent && liveStatus.get(r.id) === 'pending') : all
  },
  getMessageStatus: (id: number) => liveStatus.get(id) ?? null,
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  countNewerMessagesFromSameSender: (..._a: unknown[]) => 0,
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))
vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))
vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentWorksourceChannel: () => false,
}))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  // dex is mid-turn (busy); every other session is at an idle prompt.
  isSessionReadyForPrompt: vi.fn(async (session: string) => session !== 'agent-dex'),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (..._a: unknown[]) => true,
  capturePane: (..._a: unknown[]) => '',
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-message-wrap.js')>()
  return { ...real, classifyAgentMessage: (from: string) => ({ category: 'trusted-peer', safeFrom: from }) }
})
vi.mock('../web/telegram-inbox-wake.js', () => ({ maybeWakeSubAgentsForTelegram: vi.fn() }))

import { runMessageRouterTick, MAX_MESSAGES_PER_TICK } from '../web/message-router.js'
import { selectTickWindow } from '../web/message-router-window.js'
import type { AgentMessage } from '../db.js'

const NOW_SEC = Math.floor(Date.now() / 1000)
function row(id: number, to: string, from = 'geri'): AgentMessage {
  return { id, from_agent: from, to_agent: to, content: `payload ${id}`, created_at: NOW_SEC, origin_note: null, trace_id: null, span_id: null } as unknown as AgentMessage
}
const ids = (rows: AgentMessage[]) => rows.map((r) => r.id)

describe('selectTickWindow (fc5748f5)', () => {
  it('an idle recipient behind a busy recipient\'s 30 older rows is in the window', () => {
    const pending = [...Array.from({ length: 30 }, (_, i) => row(i + 1, 'dex')), row(31, 'eve')]
    const window = selectTickWindow(pending, 25, 'orin')
    expect(ids(window)).toContain(31)
    expect(window).toHaveLength(25)
    // The defect this replaces: the global slice leaves row 31 out entirely.
    expect(ids(pending.slice(0, 25))).not.toContain(31)
  })

  it('the main agent\'s rows take no slot (it pulls its own inbox)', () => {
    const pending = [...Array.from({ length: 30 }, (_, i) => row(i + 1, 'orin')), row(31, 'dex')]
    expect(ids(selectTickWindow(pending, 25, 'orin'))).toEqual([31])
  })

  it('a lone recipient still gets up to max rows, exactly the old window', () => {
    const pending = Array.from({ length: 30 }, (_, i) => row(i + 1, 'dex'))
    expect(ids(selectTickWindow(pending, 25, 'orin'))).toEqual(ids(pending.slice(0, 25)))
  })

  it('round-robin, recipients by their oldest row, each recipient in its own order', () => {
    const pending = [row(1, 'a'), row(2, 'a'), row(3, 'a'), row(4, 'b'), row(5, 'c'), row(6, 'c')]
    expect(ids(selectTickWindow(pending, 25, 'orin'))).toEqual([1, 4, 5, 2, 6, 3])
  })

  it('with more recipients than slots, the ones with the oldest rows win', () => {
    const pending = Array.from({ length: 30 }, (_, i) => row(i + 1, `agent${i + 1}`))
    expect(ids(selectTickWindow(pending, 25, 'orin'))).toEqual(ids(pending.slice(0, 25)))
  })

  it('never more than max rows, and nothing when nothing is pending', () => {
    const pending = Array.from({ length: 60 }, (_, i) => row(i + 1, i % 2 ? 'dex' : 'eve'))
    expect(selectTickWindow(pending, 25, 'orin')).toHaveLength(25)
    expect(selectTickWindow([], 25, 'orin')).toEqual([])
  })
})

describe('one router tick with a busy backlog in front of an idle recipient (fc5748f5)', () => {
  const env = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks(); liveStatus.clear()
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    // Batching named for nobody: the serial path, as on most installs.
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'nobody-opted-in'
  })
  afterEach(() => { process.env = { ...env } })

  it('NEGATIVE: 30 older rows for busy dex do not keep idle eve\'s message out of the tick', async () => {
    expect(MAX_MESSAGES_PER_TICK).toBe(25)
    const rows = [...Array.from({ length: 30 }, (_, i) => row(i + 1, 'dex')), row(31, 'eve')]
    for (const r of rows) liveStatus.set(r.id, 'pending')
    mockGetPendingMessages.mockReturnValue(rows)
    await runMessageRouterTick()
    const sessions = mockSendPrompt.mock.calls.map((c) => c[0])
    expect(sessions).toContain('agent-eve')
    expect(sessions).not.toContain('agent-dex')
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([31])
  })
})
