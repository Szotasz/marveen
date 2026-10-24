// The router holds an agent's rows while the context-guard restarts it
// (delivery-hold.ts), and delivers them once the hold ends.
//
// Without the hold, a message pasted into the old pane between the handoff and
// the kill died with that pane while its row said "delivered".
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)
const mockMarkDone = vi.fn((..._a: unknown[]) => true)
const mockCreateMessage = vi.fn((..._a: unknown[]) => ({ id: 999 }))
// The reconnect pre-pass's per-agent query; empty unless a test opts in.
let perAgentPending: (agent: string) => unknown[] = () => []
// Which tmux sessions exist; all of them unless a test says otherwise.
let sessionUp: (session: string) => boolean = () => true
const liveStatus = new Map<number, string | null>()
const mockGetMessageStatus = vi.fn((id: number) => liveStatus.get(id) ?? null)
// Runs inside the tick, at the readiness probe (an await between the top-of-tick
// snapshot and the send): the place a hold set mid-tick lands.
let onReadinessProbe: () => void = () => {}
let paneReady = true

const log = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }))
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn((_o: unknown, msg?: string) => { if (msg) log.info.push(msg) }),
    warn: vi.fn((_o: unknown, msg?: string) => { if (msg) log.warn.push(msg) }),
    debug: vi.fn(), error: vi.fn(),
  },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return perAgentPending(toAgent) // per-agent query of the reconnect pre-pass
    return mockGetPendingMessages()
  },
  getMessageStatus: (id: number) => mockGetMessageStatus(id),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (...a: unknown[]) => mockMarkDone(...a),
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (...a: unknown[]) => mockCreateMessage(...a),
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
  isSessionReadyForPrompt: vi.fn(async () => { onReadinessProbe(); return paneReady }),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (_host: unknown, session: string) => sessionUp(session),
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

import { runMessageRouterTick, MAX_MESSAGES_PER_TICK } from '../web/message-router.js'
import { setDeliveryHoldProbe, type DeliveryHold } from '../web/delivery-hold.js'

function row(id: number, to: string, extra: { content?: string; urgent?: number; stop_authorized?: number } = {}) {
  return {
    id, from_agent: 'orin', to_agent: to, content: `payload ${id}`,
    created_at: Math.floor(Date.now() / 1000), origin_note: null, trace_id: null, span_id: null,
    urgent: 0, stop_authorized: 0,
    ...extra,
  }
}
// An authenticated STOP from the main agent ('orin' here) and an authenticated urgent row.
const stopRow = (id: number, to: string) => row(id, to, { content: `[STOP] halt ${id}`, stop_authorized: 1 })
const urgentRow = (id: number, to: string) => row(id, to, { urgent: 1 })

function queue(rows: ReturnType<typeof row>[]) {
  liveStatus.clear()
  for (const r of rows) liveStatus.set(r.id, 'pending')
  mockGetPendingMessages.mockReturnValue(rows)
}

const held = new Set<string>()
const HOLD: DeliveryHold = { phase: 'await-handoff', untilMs: Date.now() + 600_000 }
const delivered = () => mockMarkDelivered.mock.calls.map((c) => c[0])

describe('message router: delivery hold around a context-guard restart', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    held.clear()
    log.info.length = 0
    log.warn.length = 0
    onReadinessProbe = () => {}
    paneReady = true
    perAgentPending = () => []
    sessionUp = () => true
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    setDeliveryHoldProbe((agent) => (held.has(agent) ? HOLD : null))
  })

  it('a held agent gets nothing, its rows stay pending; another agent in the same tick is delivered', async () => {
    held.add('dex')
    queue([row(1, 'dex'), row(2, 'ana'), row(3, 'dex')])

    await runMessageRouterTick()

    expect(delivered()).toEqual([2])
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPrompt.mock.calls[0][0]).toBe('agent-ana')
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('a held backlog takes no slot in the tick window: the other recipients get all of it', async () => {
    // The window is shared fairly across recipients, so a held agent left in it
    // would take about half the slots here, rows it cannot deliver anyway.
    held.add('dex')
    const backlog = Array.from({ length: MAX_MESSAGES_PER_TICK + 5 }, (_, i) => row(100 + i, 'dex'))
    const ana = Array.from({ length: MAX_MESSAGES_PER_TICK }, (_, i) => row(500 + i, 'ana'))
    queue([...backlog, ...ana])

    await runMessageRouterTick()

    expect(delivered()).toEqual(ana.map((r) => r.id))
  })

  it('when the hold ends, the next tick delivers the rows it kept', async () => {
    held.add('dex')
    queue([row(11, 'dex'), row(12, 'dex')])
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()

    held.delete('dex')
    await runMessageRouterTick()

    expect(delivered()).toEqual([11, 12])
  })

  it('a hold that starts DURING the tick is honoured before the send, and logged once', async () => {
    queue([row(21, 'max'), row(22, 'max')])
    // Not held when the tick takes its snapshot; the guard starts the restart
    // sequence while the tick awaits the pane.
    onReadinessProbe = () => { held.add('max') }

    await runMessageRouterTick()

    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
    expect(log.info.filter((m) => m.includes('delivery held --'))).toHaveLength(1)

    // Released: the next tick delivers both kept rows (and logs the release).
    held.delete('max')
    onReadinessProbe = () => {}
    await runMessageRouterTick()
    expect(delivered()).toEqual([21, 22])
    expect(log.info.filter((m) => m.includes('delivery hold released'))).toHaveLength(1)
  })

  it('logs the hold once when it starts and once when it ends, not on every tick', async () => {
    // Its own agent name: the router's "already logged" set is module state and
    // outlives a single test.
    held.add('lia')
    queue([row(31, 'lia')])
    await runMessageRouterTick()
    await runMessageRouterTick()
    held.delete('lia')
    await runMessageRouterTick()
    await runMessageRouterTick()

    expect(log.info.filter((m) => m.includes('delivery held --'))).toHaveLength(1)
    expect(log.info.filter((m) => m.includes('delivery hold released'))).toHaveLength(1)
  })

  it('the not-ready clock does not carry across the hold: the fresh session is timed from after it', async () => {
    const t0 = Date.parse('2030-01-01T10:00:00Z')
    paneReady = false
    try {
      // Not ready at t0: the router starts the session's stuck clock.
      vi.setSystemTime(t0)
      queue([row(51, 'kai')])
      await runMessageRouterTick()
      // The guard holds it while it restarts the agent.
      held.add('kai')
      vi.setSystemTime(t0 + 8 * 60_000)
      await runMessageRouterTick()
      // Released; the fresh pane is still starting. 11 minutes after t0 but only
      // 3 after the hold: not a stuck session.
      held.delete('kai')
      vi.setSystemTime(t0 + 11 * 60_000)
      await runMessageRouterTick()
      expect(log.warn.filter((m) => /stuck/i.test(m))).toEqual([])

      // Control: the same 11 minutes with no hold in between does escalate.
      queue([row(52, 'zed')])
      vi.setSystemTime(t0 + 20 * 60_000)
      await runMessageRouterTick()
      vi.setSystemTime(t0 + 31 * 60_000)
      await runMessageRouterTick()
      expect(log.warn.filter((m) => /stuck/i.test(m)).length).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failing probe means "deliver", asked once per recipient per tick, not once per row', async () => {
    const probe = vi.fn(() => { throw new Error('probe broke') })
    setDeliveryHoldProbe(probe)
    queue([row(61, 'dex'), row(62, 'dex'), row(63, 'dex'), row(64, 'ana')])

    await runMessageRouterTick()

    expect([...delivered()].sort()).toEqual([61, 62, 63, 64])
    // the top-of-tick partition asks once per recipient; the send-time check once per row sent
    const partitionCalls = probe.mock.calls.length - 4
    expect(partitionCalls).toBe(2)
  })

  it('an authenticated STOP to a held agent goes at once; its ordinary rows stay held', async () => {
    held.add('dex')
    queue([row(71, 'dex'), stopRow(72, 'dex'), row(73, 'ana')])

    await runMessageRouterTick()

    expect([...delivered()].sort()).toEqual([72, 73])
    expect(mockSendPrompt.mock.calls.map((c) => c[0]).sort()).toEqual(['agent-ana', 'agent-dex'])
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('an authenticated urgent row to a held agent goes at once as well', async () => {
    held.add('dex')
    queue([row(81, 'dex'), urgentRow(82, 'dex')])

    await runMessageRouterTick()

    expect(delivered()).toEqual([82])
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('a hold that starts DURING the tick does not stop a STOP', async () => {
    queue([stopRow(91, 'ivo')])
    onReadinessProbe = () => { held.add('ivo') }

    await runMessageRouterTick()

    expect(delivered()).toEqual([91])
  })

  it('control: a "[STOP]" text without the authentication flag is held like any row', async () => {
    held.add('dex')
    queue([row(95, 'dex', { content: '[STOP] not authenticated' })])

    await runMessageRouterTick()

    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
  })

  it('a held agent seen absent through its exempt STOP is not backlog-batched on reconnect', async () => {
    // The STOP puts the held agent in the tick window, so a restart can show its
    // session absent for a tick and present the next: the reconnect pre-pass
    // would fold the held ordinary rows into a summary and close them.
    const run = async (agent: string) => {
      const old = Math.floor(Date.now() / 1000) - 3600
      const rows = [stopRow(201, agent), ...Array.from({ length: 7 }, (_, i) => ({ ...row(210 + i, agent), created_at: old }))]
      queue(rows)
      perAgentPending = (a) => rows.filter((r) => r.to_agent === a)
      sessionUp = (s) => s !== `agent-${agent}`
      await runMessageRouterTick()
      sessionUp = () => true
      await runMessageRouterTick()
    }

    held.add('rex')
    await run('rex')
    expect(mockMarkDone).not.toHaveBeenCalled()
    expect(mockCreateMessage).not.toHaveBeenCalled()
    expect(delivered()).toEqual([201])
    // Released: the absence seen during the hold is not carried into a batch
    // now; the kept rows go out as rows.
    held.delete('rex')
    await runMessageRouterTick()
    expect(mockMarkDone).not.toHaveBeenCalled()
    expect(mockCreateMessage).not.toHaveBeenCalled()
    expect(delivered()).toEqual(expect.arrayContaining([210, 211, 212, 213, 214, 215, 216]))

    // Control: the same sequence with no hold does batch the old rows.
    vi.clearAllMocks()
    await run('rox')
    expect(mockMarkDone).toHaveBeenCalledTimes(7)
    expect(mockCreateMessage).toHaveBeenCalledTimes(1)
  })

  it('control: with no hold anywhere, everything is delivered as before', async () => {
    queue([row(41, 'dex'), row(42, 'ana')])

    await runMessageRouterTick()

    expect(delivered()).toEqual([41, 42])
  })
})
