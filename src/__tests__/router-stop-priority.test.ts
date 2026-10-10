// Card 71263d15 (C), 795d1f48: a STOP row reaches a BUSY agent now. On 2026-09-17
// an owner's stop sat pending for 30 minutes behind a single long turn, and the
// turn sent the mail it was meant to stop. Only the main agent and the system may
// send a STOP; any other sender's "[STOP]" is an ordinary row. And the row must carry
// stop_authorized, which only an in-process writer sets (the HTTP route never does:
// stop-authority.test.ts).
//
// A STOP skips ONLY the idle wait (#1809 review, reproduced live on #1835): a pane on a
// permission prompt, a first-run gate or the quota wall gets no keystroke, the row stays
// pending, and the main agent hears which agent waits on what.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PERMISSION_PANE = readFileSync(join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'), 'utf8')
const WALL_PANE = readFileSync(join(__dirname, 'fixtures/pane/quota-wall-usage-limit.txt'), 'utf8')
const SEP = '─'.repeat(80)
// A running turn: the spinner and `esc to interrupt` in the live footer (router-stuck-alert.test.ts's shape).
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

import { runMessageRouterTick, MAX_MESSAGES_PER_TICK, detectUrgentPaneHold, urgentEmitRefusal, shouldNoticeUrgentHold } from '../web/message-router.js'
import { isStopMessage, selectTickWindow, STOP_PREFIX } from '../web/message-router-window.js'
import type { AgentMessage } from '../db.js'

const NOW_SEC = Math.floor(Date.now() / 1000)
function row(id: number, to: string, from = 'geri', content = `payload ${id}`, stopAuthorized = 0): AgentMessage {
  return { id, from_agent: from, to_agent: to, content, created_at: NOW_SEC, origin_note: null, trace_id: null, span_id: null, stop_authorized: stopAuthorized } as unknown as AgentMessage
}
// An authenticated STOP: what an in-process writer creates (createAgentMessage with stopAuthorized).
const stop = (id: number, to: string, from = 'orin') => row(id, to, from, `${STOP_PREFIX} ne kuldd ki a levelet (${id})`, 1)
// The same text and sender, posted over HTTP: the route never sets stop_authorized.
const httpStop = (id: number, to: string, from = 'orin') => row(id, to, from, `${STOP_PREFIX} ne kuldd ki a levelet (${id})`, 0)
const ids = (rows: AgentMessage[]) => rows.map((r) => r.id)

describe('isStopMessage: who may stop, and what a STOP looks like', () => {
  it('the main agent and the system may send one', () => {
    expect(isStopMessage(stop(1, 'dex', 'orin'), 'orin')).toBe(true)
    expect(isStopMessage(stop(2, 'dex', 'system'), 'orin')).toBe(true)
  })
  it('any other sender\'s [STOP] is an ordinary message', () => {
    expect(isStopMessage(stop(3, 'dex', 'geri'), 'orin')).toBe(false)
    expect(isStopMessage(stop(4, 'dex', 'agent-a'), 'orin')).toBe(false)
  })
  it('the prefix opens the message (leading whitespace allowed); elsewhere it is text', () => {
    expect(isStopMessage(row(5, 'dex', 'orin', `  ${STOP_PREFIX} most`, 1), 'orin')).toBe(true)
    expect(isStopMessage(row(6, 'dex', 'orin', `Ez nem ${STOP_PREFIX}, csak idezet`, 1), 'orin')).toBe(false)
    expect(isStopMessage(row(7, 'dex', 'orin', '[stop] kisbetus', 1), 'orin')).toBe(false)
  })
  it('⛔ the main agent\'s name and the prefix are not enough: without stop_authorized it is an ordinary row', () => {
    // POST /api/messages accepts from:"<main agent>" on the shared token; such a row has stop_authorized 0.
    expect(isStopMessage(httpStop(8, 'dex', 'orin'), 'orin')).toBe(false)
    expect(isStopMessage(httpStop(9, 'dex', 'system'), 'orin')).toBe(false)
    // A row built before the column (no field at all) is not a STOP either.
    const legacy = { id: 10, from_agent: 'orin', to_agent: 'dex', content: `${STOP_PREFIX} x` } as unknown as AgentMessage
    expect(isStopMessage(legacy, 'orin')).toBe(false)
  })
})

describe('selectTickWindow puts STOP rows first (71263d15 C)', () => {
  it('a STOP behind 30 older rows of the same recipient is in the window, first', () => {
    const pending = [...Array.from({ length: 30 }, (_, i) => row(i + 1, 'dex')), stop(31, 'dex')]
    const window = selectTickWindow(pending, 25, 'orin')
    expect(ids(window)[0]).toBe(31)
    expect(window).toHaveLength(25)
    // Without the rule the round-robin takes dex's oldest 25 and leaves 31 out.
    expect(ids(pending.slice(0, 25))).not.toContain(31)
  })
  it('an ordinary [STOP]-prefixed row from another sender gets no priority', () => {
    const pending = [...Array.from({ length: 30 }, (_, i) => row(i + 1, 'dex')), stop(31, 'dex', 'geri')]
    expect(ids(selectTickWindow(pending, 25, 'orin'))).not.toContain(31)
  })
  it('an HTTP-posted [STOP] claiming the main agent gets no priority either', () => {
    const pending = [...Array.from({ length: 30 }, (_, i) => row(i + 1, 'dex')), httpStop(31, 'dex', 'orin')]
    expect(ids(selectTickWindow(pending, 25, 'orin'))).not.toContain(31)
  })
  it('without STOP rows the window is exactly the round-robin one', () => {
    const pending = [row(1, 'a'), row(2, 'a'), row(3, 'a'), row(4, 'b'), row(5, 'c'), row(6, 'c')]
    expect(ids(selectTickWindow(pending, 25, 'orin'))).toEqual([1, 4, 5, 2, 6, 3])
  })
  it('a STOP to the main agent takes no slot (it pulls its own inbox)', () => {
    expect(ids(selectTickWindow([stop(1, 'orin', 'system'), row(2, 'dex')], 25, 'orin'))).toEqual([2])
  })
})

describe('one router tick with a busy recipient (71263d15 C)', () => {
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

  it('(c1) ⛔ a STOP from the main agent is sent to the busy pane in the same tick, without the idle wait', async () => {
    queue(stop(11, 'dex'))
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const [session, text, host, opts] = mockSendPrompt.mock.calls[0]
    expect(session).toBe('agent-dex')
    expect(String(text)).toContain(STOP_PREFIX)
    expect(host).toBeNull()
    // No idle wait, and the last look at the pane inside the send lane (the emit guard).
    expect(opts).toEqual({ waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([11])
  })

  it('(c1-http) ⛔ an HTTP-posted [STOP] claiming the main agent waits for the busy pane like any row', async () => {
    queue(httpStop(12, 'dex', 'orin'))
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(12)).toBe('pending')
  })

  it('(c2) NEGATIVE CONTROL: an ordinary row to the same busy pane stays pending', async () => {
    queue(row(21, 'dex'))
    await runMessageRouterTick()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(21)).toBe('pending')
  })

  it('(c3) a [STOP] from another sender takes the ordinary path, and a STOP from the system does not', async () => {
    queue(stop(31, 'dex', 'geri'), stop(32, 'eve', 'system'))
    await runMessageRouterTick()
    expect(mockSendPrompt.mock.calls.map((c) => c[0])).toEqual(['agent-eve'])
    expect(liveStatus.get(31)).toBe('pending')
    expect(liveStatus.get(32)).toBe('delivered')
  })

  it('(c4) a STOP behind 30 older rows is delivered in the first tick; the 30 keep waiting', async () => {
    expect(MAX_MESSAGES_PER_TICK).toBe(25)
    queue(...Array.from({ length: 30 }, (_, i) => row(i + 41, 'dex')), stop(71, 'dex'))
    await runMessageRouterTick()
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([71])
    expect(rows.filter((r) => r.id !== 71).every((r) => liveStatus.get(r.id) === 'pending')).toBe(true)
  })

  it('a STOP goes alone even where batching is on: newer rows do not ride into the busy pane with it', async () => {
    // Batch mates are the head's recipient's rows with a HIGHER id (collectBatchMates takes
    // ascending ids only), so the rows that could ride along are the ones queued after it.
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'dex'
    queue(row(81, 'dex'), stop(83, 'dex'), row(84, 'dex'), row(85, 'dex'))
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const text = String(mockSendPrompt.mock.calls[0][1])
    expect(text).toContain(STOP_PREFIX)
    expect(text).not.toContain('payload 84')
    expect(text).not.toContain('payload 85')
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([83])
    expect([81, 84, 85].map((id) => liveStatus.get(id))).toEqual(['pending', 'pending', 'pending'])
  })
})

describe('a STOP to a not-ready pane leaves the stuck clock running (71263d15 C, S5)', () => {
  const env = { ...process.env }
  const MIN = 60_000
  const T0 = Date.UTC(2026, 8, 25, 10, 0, 0)
  let rows: AgentMessage[] = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.clearAllMocks(); liveStatus.clear(); ready.clear()
    rows = []
    mockGetPendingMessages.mockImplementation(() => rows)
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'nobody-opted-in'
  })
  afterEach(() => { vi.useRealTimers(); process.env = { ...env } })

  function queue(...rs: AgentMessage[]): void { for (const r of rs) { rows.push(r); liveStatus.set(r.id, 'pending') } }
  async function tickAt(ms: number): Promise<void> { vi.setSystemTime(ms); await runMessageRouterTick() }
  const stuckAlerts = (agent: string) => mockCreateMessage.mock.calls
    .filter((c) => c[1] === 'orin' && String(c[2]).startsWith('[session-stuck]') && String(c[2]).includes(`'${agent}'`))

  // A STOP passes a not-ready pane only when it reads BUSY, and a busy pane's stuck alert
  // waits for the 30 min busy watchdog (BUSY_STUCK_ESCALATE_MS), so the clock is measured there.
  it('(c5-control) without a STOP, a busy pane not ready for over 30 minutes raises one [session-stuck] alert', async () => {
    mockCapturePane.mockImplementation(() => BUSY_PANE)
    queue(row(91, 'fay'))
    await tickAt(T0)
    await tickAt(T0 + 29 * MIN)
    expect(stuckAlerts('fay')).toHaveLength(0)
    await tickAt(T0 + 30 * MIN + 1_000)
    expect(stuckAlerts('fay')).toHaveLength(1)
  })

  it('(c5) ⛔ a STOP that passes the busy pane at +29 min does not restart the clock: the alert still comes at +30 min', async () => {
    mockCapturePane.mockImplementation(() => BUSY_PANE)
    queue(row(95, 'gus'))
    await tickAt(T0)
    queue(stop(96, 'gus'))
    await tickAt(T0 + 29 * MIN)
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([96])
    await tickAt(T0 + 30 * MIN + 1_000)
    expect(stuckAlerts('gus')).toHaveLength(1)
  })
})

describe('a STOP never types into a pane that is asking something (#1809 review, point 1)', () => {
  const env = { ...process.env }
  const MIN = 60_000
  const T0 = Date.UTC(2026, 9, 10, 9, 0, 0)
  let rows: AgentMessage[] = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.clearAllMocks(); liveStatus.clear(); ready.clear()
    rows = []
    mockGetPendingMessages.mockImplementation(() => rows)
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'nobody-opted-in'
  })
  afterEach(() => { vi.useRealTimers(); process.env = { ...env } })

  function queue(...rs: AgentMessage[]): void { for (const r of rs) { rows.push(r); liveStatus.set(r.id, 'pending') } }
  async function tickAt(ms: number): Promise<void> { vi.setSystemTime(ms); await runMessageRouterTick() }
  const heldNotices = (agent: string) => mockCreateMessage.mock.calls
    .filter((c) => c[0] === 'system' && c[1] === 'orin' && String(c[2]).startsWith('[urgent-held]') && String(c[2]).includes(`'${agent}'`))

  it('(h1) ⛔ permission prompt: nothing is typed (no text, no Enter, no Escape), the row stays pending, the main agent is told', async () => {
    mockCapturePane.mockImplementation(() => PERMISSION_PANE)
    queue(stop(201, 'hal'))
    await tickAt(T0)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(liveStatus.get(201)).toBe('pending')
    const notices = heldNotices('hal')
    expect(notices).toHaveLength(1)
    const text = String(notices[0][2])
    expect(text).toContain('TOOL-PERMISSION PROMPT')
    expect(text).toContain('#201')
    expect(text).toContain('Bash command')       // the question the prompt asks, quoted
    expect(text).toContain('tmux attach -t agent-hal')
  })

  it('(h2) the notice is rate-limited: the same prompt is not told again within 10 min, and is after', async () => {
    mockCapturePane.mockImplementation(() => PERMISSION_PANE)
    queue(stop(211, 'ida'))
    await tickAt(T0)
    await tickAt(T0 + 5_000)
    await tickAt(T0 + 9 * MIN)
    expect(heldNotices('ida')).toHaveLength(1)
    await tickAt(T0 + 10 * MIN + 1_000)
    expect(heldNotices('ida')).toHaveLength(2)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(211)).toBe('pending')
  })

  it('(h3) once the prompt is answered (the pane is busy again), the held STOP goes out on the next tick', async () => {
    mockCapturePane.mockImplementation(() => PERMISSION_PANE)
    queue(stop(221, 'jon'))
    await tickAt(T0)
    expect(liveStatus.get(221)).toBe('pending')
    mockCapturePane.mockImplementation(() => BUSY_PANE)
    await tickAt(T0 + 5_000)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(liveStatus.get(221)).toBe('delivered')
  })

  it('(h4) ⛔ quota wall: nothing is typed, the row stays pending, the notice names the limit and the reset', async () => {
    mockCapturePane.mockImplementation(() => WALL_PANE)
    queue(stop(231, 'kim'))
    await tickAt(T0)
    // The walled pane even reads ready in the fixture; a STOP is held anyway.
    ready.set('agent-kim', true)
    await tickAt(T0 + 5_000)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(231)).toBe('pending')
    const notices = heldNotices('kim')
    expect(notices).toHaveLength(1)   // one wall, one notice
    expect(String(notices[0][2])).toContain('PLAN USAGE LIMIT')
    expect(String(notices[0][2])).toContain('6:20pm')
  })

  it('(h5) a not-ready pane that is neither busy nor asking takes the ordinary not-ready path: no keystroke', async () => {
    mockCapturePane.mockImplementation(() => PLAIN_NOT_READY_PANE)
    queue(stop(241, 'lou'))
    await tickAt(T0)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(241)).toBe('pending')
    expect(heldNotices('lou')).toHaveLength(0)
  })

  it('(h6) ⛔ the pane turns into a prompt between the check and the send: the guard refuses, the row stays pending', async () => {
    // The check sees a busy pane; inside the send lane the guard sees the prompt (sendPromptToSession
    // answers 'aborted-guard', sending nothing: send-prompt-emit-guard.test.ts drives that half).
    let captures = 0
    mockCapturePane.mockImplementation(() => (captures++ === 0 ? BUSY_PANE : PERMISSION_PANE))
    mockSendPrompt.mockImplementation(async () => 'aborted-guard' as unknown as 'sent')
    queue(stop(251, 'max'))
    await tickAt(T0)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(liveStatus.get(251)).toBe('pending')
    expect(heldNotices('max')).toHaveLength(1)
  })
})

describe('the hold rules as pure functions', () => {
  it('detectUrgentPaneHold reads the real fixtures, and a busy or idle pane is no hold', () => {
    expect(detectUrgentPaneHold(PERMISSION_PANE)?.kind).toBe('permission-prompt')
    expect(detectUrgentPaneHold(WALL_PANE)?.kind).toBe('quota-wall')
    expect(detectUrgentPaneHold(BUSY_PANE)).toBeNull()
    expect(detectUrgentPaneHold(null)).toBeNull()
  })
  it('urgentEmitRefusal: a prompt, a wall and an unreadable pane refuse; a busy pane types', () => {
    expect(urgentEmitRefusal(PERMISSION_PANE)).toBe('permission-prompt')
    expect(urgentEmitRefusal(WALL_PANE)).toBe('quota-wall')
    expect(urgentEmitRefusal(null)).toBe('pane unreadable')
    expect(urgentEmitRefusal('')).toBe('pane unreadable')
    expect(urgentEmitRefusal(BUSY_PANE)).toBeNull()
  })
  it('shouldNoticeUrgentHold: new or changed hold at once, the same prompt after 10 min, the same wall after 5 h', () => {
    const p = detectUrgentPaneHold(PERMISSION_PANE)!
    const w = detectUrgentPaneHold(WALL_PANE)!
    const t = 1_000_000_000
    expect(shouldNoticeUrgentHold(p, undefined, t)).toBe(true)
    expect(shouldNoticeUrgentHold(p, { key: 'quota-wall:6:20pm', at: t }, t + 1)).toBe(true)
    const pk = { key: 'permission:' + (p.kind === 'permission-prompt' ? p.ask?.title ?? '?' : ''), at: t }
    expect(shouldNoticeUrgentHold(p, pk, t + 9 * 60_000)).toBe(false)
    expect(shouldNoticeUrgentHold(p, pk, t + 10 * 60_000)).toBe(true)
    expect(shouldNoticeUrgentHold(w, { key: 'quota-wall:6:20pm', at: t }, t + 4 * 3_600_000)).toBe(false)
    expect(shouldNoticeUrgentHold(w, { key: 'quota-wall:6:20pm', at: t }, t + 5 * 3_600_000)).toBe(true)
  })
})
