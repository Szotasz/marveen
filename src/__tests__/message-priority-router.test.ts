import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { compareDeliveryOrder } from '../delivery-order.js'

// Card ad771121: the router's side of priority delivery. The DB hands the router a recipient's rows in
// delivery order (high first, then FIFO; measured on SQLite in message-priority.test.ts). Two places in
// the router then had to follow that order instead of the id or the age:
//   - the batch (collectBatchMates): its "ascending only" guard compared ids, so behind a NEWER high
//     head the OLDER normal rows were left out of the injection -- now the guard is the delivery order;
//   - the reconnect backlog summary: a high row is never folded into it, it is delivered on its own.
// Same harness as router-batch-inject.test.ts; the order of the snapshot comes from the real
// compareDeliveryOrder (src/delivery-order.ts), never from a hand-written list.

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkDone = vi.fn((..._a: unknown[]) => true)
const mockCreate = vi.fn((..._a: unknown[]) => ({ id: 999 }))
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)
const liveStatus = new Map<number, string | null>()
const sessionPresent = new Map<string, boolean>()

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
    const all = (mockGetPendingMessages() as Array<{ id: number; to_agent: string }>).filter((r) => liveStatus.get(r.id) === 'pending')
    return toAgent ? all.filter((r) => r.to_agent === toAgent) : all
  },
  getMessageStatus: (id: number) => liveStatus.get(id) ?? null,
  markMessageDelivered: (...a: unknown[]) => { liveStatus.set(a[0] as number, 'delivered'); return mockMarkDelivered(...a) },
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (...a: unknown[]) => { liveStatus.set(a[0] as number, 'done'); return mockMarkDone(...a) },
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (...a: unknown[]) => mockCreate(...a),
  countNewerMessagesFromSameSender: () => 0,
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
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (_host: unknown, session: string) => sessionPresent.get(session.replace(/^agent-/, '')) ?? true,
  capturePane: (..._a: unknown[]) => '',
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-message-wrap.js')>()
  return { ...real, classifyAgentMessage: (from: string) => ({ category: 'trusted-peer', safeFrom: from }) }
})
vi.mock('../web/telegram-inbox-wake.js', () => ({ maybeWakeSubAgentsForTelegram: vi.fn() }))

import { runMessageRouterTick } from '../web/message-router.js'

type Row = { id: number; to: string; ageSec: number; priority?: number; content?: string }
function snapshot(rows: Row[]) {
  const nowSec = Math.floor(Date.now() / 1000)
  liveStatus.clear()
  for (const r of rows) liveStatus.set(r.id, 'pending')
  const full = rows.map((r) => ({
    id: r.id, from_agent: 'kuldo', to_agent: r.to, content: r.content ?? `payload ${r.id}`,
    created_at: nowSec - r.ageSec, priority: r.priority ?? 0, origin_note: null, trace_id: null, span_id: null,
  }))
  mockGetPendingMessages.mockReturnValue(full.sort(compareDeliveryOrder))
}
const sentTexts = () => mockSendPrompt.mock.calls.map((c) => String(c[1]))

describe('message router: priority delivery (ad771121)', () => {
  const env = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks(); liveStatus.clear(); sessionPresent.clear()
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'dex'
    delete process.env.ROUTER_BATCH_INJECT_MAX
  })
  afterEach(() => { process.env = { ...env } })

  it('a NEWER high head takes the OLDER normal rows with it, in delivery order, in one injection', async () => {
    snapshot([
      { id: 901, to: 'dex', ageSec: 300 }, { id: 902, to: 'dex', ageSec: 200 }, { id: 903, to: 'dex', ageSec: 100 },
      { id: 950, to: 'dex', ageSec: 5, priority: 1, content: 'urgent GO' },
    ])
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const text = sentTexts()[0]
    const pos = [950, 901, 902, 903].map((id) => text.indexOf(`msg_id:${id}`))
    expect(pos.every((p) => p > -1), `every row in the one injection: ${pos}`).toBe(true)
    expect(pos).toEqual([...pos].sort((a, b) => a - b))
    expect(mockMarkDelivered.mock.calls.map((c) => c[0]).sort()).toEqual([901, 902, 903, 950])
  })

  it('NEGATIVE CONTROL: without a high row the batch is the old ascending FIFO', async () => {
    snapshot([{ id: 911, to: 'dex', ageSec: 30 }, { id: 912, to: 'dex', ageSec: 20 }, { id: 913, to: 'dex', ageSec: 10 }])
    await runMessageRouterTick()
    const text = sentTexts()[0]
    const pos = [911, 912, 913].map((id) => text.indexOf(`msg_id:${id}`))
    expect(pos.every((p) => p > -1)).toBe(true)
    expect(pos).toEqual([...pos].sort((a, b) => a - b))
  })

  it('a high row is NOT folded into the reconnect backlog summary; it is delivered on its own', async () => {
    const rows: Row[] = [40, 41, 42, 43, 44, 45].map((m, i) => ({ id: 960 + i, to: 'visszatero', ageSec: m * 60 }))
    rows.push({ id: 970, to: 'visszatero', ageSec: 45 * 60, priority: 1, content: 'urgent while away' })
    snapshot(rows)
    sessionPresent.set('visszatero', false)          // tick 1: away
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    sessionPresent.set('visszatero', true)           // tick 2: back -> backlog summary
    await runMessageRouterTick()
    const doneIds = mockMarkDone.mock.calls.map((c) => c[0])
    expect(doneIds.sort()).toEqual([960, 961, 962, 963, 964, 965])
    expect(doneIds).not.toContain(970)
    const summary = mockCreate.mock.calls.map((c) => String(c[2])).find((t) => t.includes('[BACKLOG-SUMMARY]')) ?? ''
    expect(summary).toContain('6 inter-agent message(s)')
    expect(summary).not.toContain('urgent while away')
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toContain(970)
  })
})
