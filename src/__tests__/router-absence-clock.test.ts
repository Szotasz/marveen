// Card 71263d15 (A): a message is abandoned when its recipient has been ABSENT
// WITHOUT A BREAK for the whole window, not when the message is older than the
// window; and the SENDER hears about every failure, not only the main agent.
//
// Measured 2026-09-24: 23 abandoned messages. 12 went to live, busy agents whose
// session blinked out for 21 s to 3.9 min while the message was already over an
// hour old (it had waited behind the busy turn), and 4 were dropped five seconds
// after a dashboard restart, before the sessions came up. The sender had an id
// back for each of them and heard nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockCreateMessage = vi.fn((..._a: unknown[]) => ({ id: 999 }))
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)
const present = new Map<string, boolean>()
const ready = new Map<string, boolean>()
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
    const all = (mockGetPendingMessages() as Array<{ id: number; to_agent: string }>)
      .filter((r) => liveStatus.get(r.id) === 'pending')
    return toAgent ? all.filter((r) => r.to_agent === toAgent) : all
  },
  getMessageStatus: (id: number) => liveStatus.get(id) ?? null,
  markMessageDelivered: (...a: unknown[]) => { liveStatus.set(a[0] as number, 'delivered'); return mockMarkDelivered(...a) },
  markMessageFailed: (...a: unknown[]) => { liveStatus.set(a[0] as number, 'failed'); return mockMarkFailed(...a) },
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (...a: unknown[]) => mockCreateMessage(...a),
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
  isSessionReadyForPrompt: vi.fn(async (session: string) => ready.get(session) ?? false),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (_host: unknown, session: string) => present.get(session) ?? true,
  capturePane: (..._a: unknown[]) => '',
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-message-wrap.js')>()
  return {
    ...real,
    classifyAgentMessage: (from: string) => {
      if (from === 'boom') throw new Error('classify exploded')
      return { category: 'trusted-peer', safeFrom: from }
    },
  }
})
vi.mock('../web/telegram-inbox-wake.js', () => ({ maybeWakeSubAgentsForTelegram: vi.fn() }))

import {
  runMessageRouterTick,
  shouldNotifySenderOfFailure,
  formatSenderFailureNotice,
} from '../web/message-router.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'
import type { AgentMessage } from '../db.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 8, 25, 10, 0, 0)

function row(id: number, to: string, from: string, createdMs: number): AgentMessage {
  return {
    id, from_agent: from, to_agent: to, content: `payload ${id}`, created_at: Math.floor(createdMs / 1000),
    origin_note: null, trace_id: null, span_id: null,
  } as unknown as AgentMessage
}

async function tickAt(ms: number): Promise<void> {
  vi.setSystemTime(ms)
  await runMessageRouterTick()
}

const failedIds = () => mockMarkFailed.mock.calls.map((c) => c[0])
const noticesTo = (agent: string) => mockCreateMessage.mock.calls.filter((c) => c[0] === 'system' && c[1] === agent)

describe('71263d15 (A): the absence clock decides, not the message age', () => {
  const env = { ...process.env }
  let rows: AgentMessage[] = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.clearAllMocks()
    liveStatus.clear(); present.clear(); ready.clear()
    rows = []
    mockGetPendingMessages.mockImplementation(() => rows)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    mockMarkFailed.mockImplementation(() => true)
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'nobody-opted-in'
  })
  afterEach(() => { vi.useRealTimers(); process.env = { ...env } })

  function queue(r: AgentMessage): void { rows.push(r); liveStatus.set(r.id, 'pending') }

  it('(a1) ⛔ a 70-minute-old message survives a recipient that is absent only on the latest tick', async () => {
    // The 2026-09-24 07:54:43Z shape: busy for over an hour, then a 26 s absence.
    queue(row(101, 'ann', 'geri', T0 - 70 * MIN))
    present.set('agent-ann', true)
    await tickAt(T0)                      // busy: not ready, stays pending
    present.set('agent-ann', false)
    await tickAt(T0 + 10_000)             // absent for the first time, 10 s
    expect(failedIds()).not.toContain(101)
    expect(liveStatus.get(101)).toBe('pending')
  })

  it('(a2) POSITIVE CONTROL: a recipient absent for 61 minutes without a break does fail the message', async () => {
    queue(row(201, 'bob', 'geri', T0))
    present.set('agent-bob', false)
    await tickAt(T0)
    await tickAt(T0 + 30 * MIN)
    expect(failedIds()).not.toContain(201)
    await tickAt(T0 + 61 * MIN)
    expect(failedIds()).toContain(201)
  })

  it('(a3) a sighting between two absences resets the clock', async () => {
    queue(row(301, 'cid', 'geri', T0))
    present.set('agent-cid', false)
    await tickAt(T0)                      // absent since T0
    present.set('agent-cid', true)
    await tickAt(T0 + 30 * MIN)           // seen again: clock cleared
    present.set('agent-cid', false)
    await tickAt(T0 + 31 * MIN)           // absent again, since T0+31
    await tickAt(T0 + 61 * MIN)           // 30 min of absence only
    expect(failedIds()).not.toContain(301)
    await tickAt(T0 + 92 * MIN + 1)       // 61 min since T0+31
    expect(failedIds()).toContain(301)
  })

  it('(a4) the failure lands in the SENDER\'s inbox as a [handoff-failure] system row, not in the recipient\'s', async () => {
    queue(row(401, 'dia', 'geri', T0))
    present.set('agent-dia', false)
    await tickAt(T0)
    await tickAt(T0 + 61 * MIN)
    expect(failedIds()).toContain(401)
    const toSender = noticesTo('geri')
    expect(toSender).toHaveLength(1)
    expect(String(toSender[0][2])).toContain('[handoff-failure]')
    expect(String(toSender[0][2])).toContain('#401')
    expect(noticesTo('dia')).toHaveLength(0)
    // The main agent's notice is unchanged, alongside.
    expect(noticesTo('orin').some((c) => String(c[2]).includes('id 401'))).toBe(true)
  })

  it('(a5) three inject failures give ONE sender notice, not three', async () => {
    queue(row(501, 'eli', 'geri', T0))
    present.set('agent-eli', true); ready.set('agent-eli', true)
    mockSendPrompt.mockImplementation(async () => { throw new Error('send-keys failed') })
    await tickAt(T0)
    await tickAt(T0 + 5_000)
    expect(noticesTo('geri')).toHaveLength(0)   // retries are not failures yet
    await tickAt(T0 + 10_000)
    expect(failedIds()).toContain(501)
    expect(noticesTo('geri')).toHaveLength(1)
  })

  it('(a6) a failed \'system\' message and a failed main-agent message produce no sender notice', async () => {
    queue(row(601, 'fay', 'system', T0))
    queue(row(602, 'fay', 'orin', T0))
    present.set('agent-fay', false)
    await tickAt(T0)
    await tickAt(T0 + 61 * MIN)
    expect(failedIds()).toEqual(expect.arrayContaining([601, 602]))
    expect(noticesTo('system')).toHaveLength(0)
    // 'orin' is the main agent: it gets the orchestrator notices, and no second, sender-shaped one.
    expect(noticesTo('orin').filter((c) => String(c[2]).includes('küldött üzeneted'))).toHaveLength(0)
  })

  it('(a7) the fault-isolation branch no longer fails a row silently', async () => {
    queue(row(701, 'gus', 'boom', T0))
    present.set('agent-gus', true); ready.set('agent-gus', true)
    await tickAt(T0)
    expect(failedIds()).toContain(701)
    expect(noticesTo('boom')).toHaveLength(1)
    expect(noticesTo('orin').some((c) => String(c[2]).includes('id 701'))).toBe(true)
  })

  it('a row closed concurrently (markMessageFailed affected 0 rows) earns no sender notice', async () => {
    queue(row(801, 'hal', 'geri', T0))
    present.set('agent-hal', false)
    await tickAt(T0)
    mockMarkFailed.mockReturnValueOnce(false)
    await tickAt(T0 + 61 * MIN)
    expect(noticesTo('geri')).toHaveLength(0)
  })
  it('(a8) ⛔ S1: after an abandon, a recipient that came back unobserved does not keep the old clock', async () => {
    // S1a: its rows were all abandoned, so no tick looked at the recipient any more;
    // hours later a FRESH message met a 5 s blip and failed at once, as "absent for the whole window".
    queue(row(801, 'hal', 'geri', T0))
    present.set('agent-hal', false)
    await tickAt(T0)
    await tickAt(T0 + 61 * MIN)
    expect(failedIds()).toContain(801)      // the real 61-minute absence still fails
    present.set('agent-hal', true)          // back, with nothing pending: no tick looks at it
    await tickAt(T0 + 90 * MIN)
    queue(row(802, 'hal', 'geri', T0 + 300 * MIN))
    present.set('agent-hal', false)         // a restart blip, seconds long
    await tickAt(T0 + 300 * MIN + 5_000)
    expect(failedIds()).not.toContain(802)
    expect(liveStatus.get(802)).toBe('pending')
    // The clock is not switched off: it restarted at the blip, and 61 minutes on it fails.
    await tickAt(T0 + 361 * MIN + 5_001)
    expect(failedIds()).toContain(802)
  })

  it('(a9) ⛔ S1: a row closed from outside while its recipient was absent leaves no clock behind', async () => {
    // S1b: absent on one tick only, the row closed through the status endpoint.
    queue(row(901, 'ida', 'geri', T0))
    present.set('agent-ida', false)
    await tickAt(T0)
    liveStatus.set(901, 'done')
    present.set('agent-ida', true)
    await tickAt(T0 + 1 * MIN)
    queue(row(902, 'ida', 'geri', T0 + 120 * MIN))
    present.set('agent-ida', false)
    await tickAt(T0 + 120 * MIN + 5_000)
    expect(failedIds()).not.toContain(902)
    expect(liveStatus.get(902)).toBe('pending')
  })
})

describe('71263d15 (A): who may get a sender notice, and what it says', () => {
  it('no receipt for system, the main agent, federated or channel-inbound senders', () => {
    expect(shouldNotifySenderOfFailure('system', 'orin')).toBe(false)
    expect(shouldNotifySenderOfFailure('orin', 'orin')).toBe(false)
    expect(shouldNotifySenderOfFailure('peer/agent', 'orin')).toBe(false)
    expect(shouldNotifySenderOfFailure(COORDINATOR_AGENT_ID, 'orin')).toBe(false)
    expect(shouldNotifySenderOfFailure(VOICE_CHANNEL_AGENT_ID, 'orin')).toBe(false)
    expect(shouldNotifySenderOfFailure('', 'orin')).toBe(false)
    expect(shouldNotifySenderOfFailure('geri', 'orin')).toBe(true)
  })

  it('the notice says the id confirmed acceptance, and marks how much of the preview it cut', () => {
    const long = { id: 9, from_agent: 'geri', to_agent: 'dex', content: 'x'.repeat(500) } as unknown as AgentMessage
    const text = formatSenderFailureNotice(long, 'ok')
    expect(text).toContain('[handoff-failure]')
    expect(text).toContain('#9')
    expect(text).toContain('befogadást')
    expect(text).toContain('[... +280 karakter]')
    const short = { id: 10, from_agent: 'geri', to_agent: 'dex', content: 'rovid' } as unknown as AgentMessage
    expect(formatSenderFailureNotice(short, 'ok')).not.toContain('karakter]')
  })
})
