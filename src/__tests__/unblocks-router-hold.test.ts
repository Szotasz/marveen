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
  readAgentPullDelivery: () => false,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentWorksourceChannel: () => false,
}))
vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
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

import { runMessageRouterTick, urgentEmitRefusal } from '../web/message-router.js'
import type { AgentMessage } from '../db.js'

// Card #673: an `affects_current_work: unblocks` row from the main agent takes the urgent/STOP pane-passing path,
// and with it the SAME pane-hold check: a pane that is asking something (a permission prompt, the quota wall)
// gets no keystroke. Behavioural, through a real router tick -- the source-text pins in unblocks-interrupt.test.ts
// cannot tell a deleted hold check from a kept one (PR #2279 review: removing it left 15/15 green).
const NOW_SEC = Math.floor(Date.now() / 1000)
function unblock(id: number, to: string, from = 'orin', flag: string | null = 'unblocks'): AgentMessage {
  return {
    id, from_agent: from, to_agent: to, content: `jóváhagyás megjött (${id})`, created_at: NOW_SEC,
    origin_note: null, trace_id: null, span_id: null, stop_authorized: 0, affects_current_work: flag,
  } as unknown as AgentMessage
}

describe('an unblock row at a busy or asking pane (#673)', () => {
  const env = { ...process.env }
  const MIN = 60_000
  const T0 = Date.UTC(2026, 9, 27, 9, 0, 0)
  let rows: AgentMessage[] = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.clearAllMocks(); liveStatus.clear(); ready.clear()
    rows = []
    mockGetPendingMessages.mockImplementation(() => rows)
    mockMarkDelivered.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
    mockCapturePane.mockImplementation(() => BUSY_PANE)
    process.env.ROUTER_BATCH_INJECT_AGENTS = 'nobody-opted-in'
  })
  afterEach(() => { vi.useRealTimers(); process.env = { ...env } })

  function queue(...rs: AgentMessage[]): void { for (const r of rs) { rows.push(r); liveStatus.set(r.id, 'pending') } }
  async function tickAt(ms: number): Promise<void> { vi.setSystemTime(ms); await runMessageRouterTick() }
  const heldNotices = (agent: string) => mockCreateMessage.mock.calls
    .filter((c) => c[0] === 'system' && c[1] === 'orin' && String(c[2]).startsWith('[urgent-held]') && String(c[2]).includes(`'${agent}'`))

  it('(u1) a flagged row from the main agent reaches the busy pane at once: no idle wait, the emit guard, a short accented notice', async () => {
    queue(unblock(301, 'kai'))
    await tickAt(T0)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    const [session, text, host, opts] = mockSendPrompt.mock.calls[0]
    expect(session).toBe('agent-kai')
    expect(host).toBeNull()
    expect(opts).toEqual({ waitForIdle: false, emitGuard: urgentEmitRefusal })
    expect(String(text)).toContain('FELOLDÁS')
    expect(String(text)).toContain('jóváhagyás megjött (301)')
    expect(liveStatus.get(301)).toBe('delivered')
  })

  it('(u2) NEGATIVE CONTROLS: the same row without the flag, or the flag from another sender, waits like any row', async () => {
    queue(unblock(311, 'lia', 'orin', null), unblock(312, 'mo', 'geri'))
    await tickAt(T0)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(311)).toBe('pending')
    expect(liveStatus.get(312)).toBe('pending')
  })

  it('(u3) ⛔ a pane on a permission prompt gets NO keystroke: the row stays pending and the main agent is told', async () => {
    mockCapturePane.mockImplementation(() => PERMISSION_PANE)
    queue(unblock(321, 'nel'))
    await tickAt(T0)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(liveStatus.get(321)).toBe('pending')
    const notices = heldNotices('nel')
    expect(notices).toHaveLength(1)
    expect(String(notices[0][2])).toContain('TOOL-PERMISSION PROMPT')
    expect(String(notices[0][2])).toContain('#321')
  })

  it('(u4) ⛔ the quota wall holds it too, and once the pane is busy again the row goes out on the next tick', async () => {
    mockCapturePane.mockImplementation(() => WALL_PANE)
    queue(unblock(331, 'oto'))
    await tickAt(T0)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(liveStatus.get(331)).toBe('pending')
    mockCapturePane.mockImplementation(() => BUSY_PANE)
    await tickAt(T0 + MIN)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(liveStatus.get(331)).toBe('delivered')
  })
})
