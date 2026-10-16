// Card 795d1f48 (a): an authenticated URGENT row reaches a BUSY agent, the general form of the 71263d15 STOP path.
// The use case (card 7dc0dd24): the save signal a key rotation sends before it restarts the agents must reach an agent in
// the middle of a long turn, where the bus only injects into idle panes. An urgent row is one whose `urgent` column is 1;
// only an in-process writer or a device key the install lists can set it (POST /api/messages refuses everyone else,
// urgent-bus-auth.test.ts). The router sends it with the existing writer (sendPromptToSession,
// waitForIdle: false), exactly like a STOP: the writer's modal close, PANEWRITERS805 lane and prompt-head guard apply.
// And exactly like a STOP it skips ONLY the idle wait (#1835 review, finding 1, measured live): a pane on a permission
// prompt or the quota wall gets no keystroke, the row stays pending, and the main agent is told.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PERMISSION_PANE = readFileSync(join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'), 'utf8')
const WALL_PANE = readFileSync(join(__dirname, 'fixtures/pane/quota-wall-usage-limit.txt'), 'utf8')
const SEP = '─'.repeat(80)
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')
// Not ready, not busy, not asking anything the detectors know: 'unknown'.
const PLAIN_NOT_READY_PANE = ['Some tool output that is not a prompt', '', SEP, '  loading…', SEP].join('\n')
const mockCapturePane = vi.fn((..._a: unknown[]): string | null => BUSY_PANE)

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockSendPrompt = vi.fn(async (..._a: unknown[]) => 'sent' as const)
const mockCreateMessage = vi.fn((..._a: unknown[]) => ({ id: 999 }))
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
  markMessageFailed: (..._a: unknown[]) => true,
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
  // Every session is mid-turn unless a test marks it ready.
  isSessionReadyForPrompt: vi.fn(async (session: string) => ready.get(session) ?? false),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: (..._a: unknown[]) => true,
  capturePane: (...a: unknown[]) => mockCapturePane(...a),
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-message-wrap.js')>()
  return { ...real, classifyAgentMessage: (from: string) => ({ category: 'trusted-peer', safeFrom: from }) }
})
vi.mock('../web/telegram-inbox-wake.js', () => ({ maybeWakeSubAgentsForTelegram: vi.fn() }))

import { runMessageRouterTick, MAX_MESSAGES_PER_TICK, urgentEmitRefusal } from '../web/message-router.js'
import { isStopMessage, isUrgentDelivery, selectTickWindow, STOP_PREFIX } from '../web/message-router-window.js'
import type { AgentMessage } from '../db.js'

const NOW_SEC = Math.floor(Date.now() / 1000)
function row(id: number, to: string, from = 'infra', content = `payload ${id}`, urgent = 0, stopAuthorized = 0): AgentMessage {
  return { id, from_agent: from, to_agent: to, content, created_at: NOW_SEC, origin_note: null, trace_id: null, span_id: null, urgent, stop_authorized: stopAuthorized } as unknown as AgentMessage
}
const urgentRow = (id: number, to: string, from = 'infra') => row(id, to, from, `MENTESI JELZES (${id})`, 1)
const ids = (rows: AgentMessage[]) => rows.map((r) => r.id)

describe('isUrgentDelivery: the urgent column, or a STOP', () => {
  it('a row with urgent = 1 is urgent, whoever the sender', () => {
    expect(isUrgentDelivery(urgentRow(1, 'dex', 'infra'), 'orin')).toBe(true)
    expect(isUrgentDelivery(urgentRow(2, 'dex', 'system'), 'orin')).toBe(true)
  })
  it('urgent = 0 and a row from before the column (undefined) are ordinary', () => {
    expect(isUrgentDelivery(row(3, 'dex'), 'orin')).toBe(false)
    const old = row(4, 'dex') as unknown as Record<string, unknown>
    delete old.urgent
    expect(isUrgentDelivery(old as unknown as AgentMessage, 'orin')).toBe(false)
  })
  it('the STOP rule: the main agent or the system with the prefix, on an authenticated row (in-process), nobody else', () => {
    expect(isUrgentDelivery(row(5, 'dex', 'orin', `${STOP_PREFIX} most`, 0, 1), 'orin')).toBe(true)
    expect(isUrgentDelivery(row(6, 'dex', 'geri', `${STOP_PREFIX} most`, 0, 1), 'orin')).toBe(false)
    // The shared token's row: the main agent's name and the prefix, no flag -> ordinary.
    expect(isUrgentDelivery(row(7, 'dex', 'orin', `${STOP_PREFIX} most`), 'orin')).toBe(false)
  })
  it('the urgent lane authenticates a STOP too (a listed device key), but only for the main agent or the system', () => {
    expect(isStopMessage(row(8, 'dex', 'orin', `${STOP_PREFIX} most`, 1), 'orin')).toBe(true)
    // An urgent row from a peer with the prefix is urgent, not a STOP.
    expect(isStopMessage(row(9, 'dex', 'infra', `${STOP_PREFIX} most`, 1), 'orin')).toBe(false)
    expect(isUrgentDelivery(row(9, 'dex', 'infra', `${STOP_PREFIX} most`, 1), 'orin')).toBe(true)
  })
})

describe('selectTickWindow puts urgent rows first', () => {
  it('an urgent row behind 30 older rows of the same recipient is in the window, first', () => {
    const pending = [...Array.from({ length: 30 }, (_, i) => row(i + 1, 'dex')), urgentRow(31, 'dex')]
    const window = selectTickWindow(pending, 25, 'orin')
    expect(ids(window)[0]).toBe(31)
    expect(window).toHaveLength(25)
  })
  it('an urgent row to the main agent takes no slot (the main agent pulls its own inbox)', () => {
    expect(ids(selectTickWindow([urgentRow(1, 'orin'), row(2, 'dex')], 25, 'orin'))).toEqual([2])
  })
})

describe('one router tick with a busy recipient (795d1f48 a)', () => {
  const env = { ...process.env }
  let rows: AgentMessage[] = []
  beforeEach(() => {
    vi.clearAllMocks(); liveStatus.clear(); ready.clear()
    rows = []
    mockGetPendingMessages.mockImplementation(() => rows)
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    mockCapturePane.mockImplementation(() => BUSY_PANE)
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'nobody-opted-in'
  })
  afterEach(() => { process.env = { ...env } })

  function queue(...rs: AgentMessage[]): void { for (const r of rs) { rows.push(r); liveStatus.set(r.id, 'pending') } }

  it('(u1) an urgent row is sent to the busy pane in the same tick, with the existing writer and no idle wait', async () => {
    queue(urgentRow(11, 'dex'))
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const [session, text, host, opts] = mockSendPrompt.mock.calls[0]
    expect(session).toBe('agent-dex')
    expect(String(text)).toContain('MENTESI JELZES (11)')
    expect(host).toBeNull()
    expect(opts).toEqual({ waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([11])
  })

  it('(u2) NEGATIVE CONTROL: the same row without the urgent column waits for the busy pane', async () => {
    queue(row(21, 'dex', 'infra', 'MENTESI JELZES (21)'))
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(21)).toBe('pending')
  })

  it('(u3) the ordinary row reaches the pane once it is idle (the negative control is a wait, not a loss)', async () => {
    queue(row(25, 'dex'))
    await runMessageRouterTick()
    expect(liveStatus.get(25)).toBe('pending')
    ready.set('agent-dex', true)
    await runMessageRouterTick()
    expect(mockSendPrompt.mock.calls.map((c) => c[0])).toEqual(['agent-dex'])
    expect(mockSendPrompt.mock.calls[0][3]).toBeUndefined()
    expect(liveStatus.get(25)).toBe('delivered')
  })

  it('(u4) an urgent row behind 30 older rows is delivered in the first tick; the 30 keep waiting', async () => {
    expect(MAX_MESSAGES_PER_TICK).toBe(25)
    queue(...Array.from({ length: 30 }, (_, i) => row(i + 41, 'dex')), urgentRow(71, 'dex'))
    await runMessageRouterTick()
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([71])
    expect(rows.filter((r) => r.id !== 71).every((r) => liveStatus.get(r.id) === 'pending')).toBe(true)
  })

  it('(u5) an urgent row goes alone where batching is on: newer rows do not ride into the busy pane with it', async () => {
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'dex'
    queue(row(81, 'dex'), urgentRow(83, 'dex'), row(84, 'dex'), row(85, 'dex'))
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const text = String(mockSendPrompt.mock.calls[0][1])
    expect(text).toContain('MENTESI JELZES (83)')
    expect(text).not.toContain('payload 84')
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([83])
    expect([81, 84, 85].map((id) => liveStatus.get(id))).toEqual(['pending', 'pending', 'pending'])
  })

  it('(u6) the delivered sender line names the row urgent, inside the line the machine-origin detector anchors to', async () => {
    ready.set('agent-eve', true)
    queue(urgentRow(91, 'dex'), row(92, 'eve'))
    await runMessageRouterTick()
    const byS = new Map(mockSendPrompt.mock.calls.map((c) => [c[0], String(c[1])]))
    const urgentLine = (byS.get('agent-dex') ?? '').split('\n').find((l) => l.startsWith('[Uzenet @')) ?? ''
    expect(urgentLine).toMatch(/^\[Uzenet @infra-tol -- trusted team member, msg_id:91, URGENT \(authenticated row\)\]: /)
    expect(byS.get('agent-eve') ?? '').not.toContain('URGENT')
  })
})

describe('an urgent row never types into a pane that is asking something (#1835 review, finding 1)', () => {
  const env = { ...process.env }
  let rows: AgentMessage[] = []
  beforeEach(() => {
    vi.clearAllMocks(); liveStatus.clear(); ready.clear()
    rows = []
    mockGetPendingMessages.mockImplementation(() => rows)
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'nobody-opted-in'
  })
  afterEach(() => { process.env = { ...env } })

  function queue(...rs: AgentMessage[]): void { for (const r of rs) { rows.push(r); liveStatus.set(r.id, 'pending') } }
  const heldNotices = (agent: string) => mockCreateMessage.mock.calls
    .filter((c) => c[0] === 'system' && c[1] === 'orin' && String(c[2]).startsWith('[urgent-held]') && String(c[2]).includes(`'${agent}'`))

  it('(uh1) ⛔ permission prompt (the measured case): nothing typed, the row stays pending, the main agent is told it is an URGENT row', async () => {
    mockCapturePane.mockImplementation(() => PERMISSION_PANE)
    queue(urgentRow(301, 'pia'))
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(liveStatus.get(301)).toBe('pending')
    const notices = heldNotices('pia')
    expect(notices).toHaveLength(1)
    expect(String(notices[0][2])).toContain('URGENT row #301 (from infra)')
    expect(String(notices[0][2])).toContain('TOOL-PERMISSION PROMPT')
  })

  it('(uh2) ⛔ quota wall: nothing typed, the row stays pending, the notice names the limit', async () => {
    mockCapturePane.mockImplementation(() => WALL_PANE)
    queue(urgentRow(311, 'quin'))
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(311)).toBe('pending')
    expect(String(heldNotices('quin')[0]?.[2])).toContain('PLAN USAGE LIMIT')
  })

  it('(uh3) a STOP sent on the urgent lane by a listed key is labelled STOP in the notice', async () => {
    mockCapturePane.mockImplementation(() => PERMISSION_PANE)
    queue(row(321, 'rex', 'orin', `${STOP_PREFIX} allj meg`, 1))
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(String(heldNotices('rex')[0]?.[2])).toContain('STOP row #321 (from orin)')
  })

  it('(uh5) a not-ready pane that is neither busy nor asking takes the ordinary not-ready path: no keystroke', async () => {
    mockCapturePane.mockImplementation(() => PLAIN_NOT_READY_PANE)
    queue(urgentRow(341, 'tia'))
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(341)).toBe('pending')
    expect(heldNotices('tia')).toHaveLength(0)
  })

  it('(uh4) once the pane is busy again, the held urgent row goes out', async () => {
    mockCapturePane.mockImplementation(() => PERMISSION_PANE)
    queue(urgentRow(331, 'sam'))
    await runMessageRouterTick()
    expect(liveStatus.get(331)).toBe('pending')
    mockCapturePane.mockImplementation(() => BUSY_PANE)
    await runMessageRouterTick()
    expect(liveStatus.get(331)).toBe('delivered')
  })
})
