// MODALPOSTEST831: the POSITIVE half of the #1123 wiring, message-router leg.
//
// The seven injector fixtures stub clearFeedbackModalAndRecheck to false (no
// modal), so until now "helper=true -> the caller PROCEEDS" stood only on code
// reading -- the second half of tested-is-not-wired. This pins it by driving
// runMessageRouterTick through the real refusal branch:
//
//   tick 1: session exists, NOT ready, helper returns true (modal cleared)
//           -> the message is NOT failed, NOT delivered yet (continue;
//              delivery belongs to the next tick), and the helper was
//              actually consulted;
//   tick 2: session now ready -> the SAME message is delivered.
//
// The negative control keeps the helper at false on a not-ready session and
// asserts nothing is delivered -- so a regression that short-circuits before
// the helper (an earlier readiness gate, the exact bug class #1123 fixed)
// turns tick 1's helper-consulted assertion red.

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
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
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
  isKnownAgent: () => true,
  agentDir: () => '/tmp/none-agentdir',
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: (...a: unknown[]) => mockClearModal(...(a as [])),
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsReady(...(a as [])),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...(a as [])),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

import { runMessageRouterTick } from '../web/message-router.js'

function pendingMsg(id: number) {
  return {
    id,
    from_agent: 'marveen',
    to_agent: 'samu',
    content: 'held behind the modal',
    status: 'pending',
    created_at: Math.floor(Date.now() / 1000),
  }
}

describe('message router: modal cleared on the refusal branch -> delivery proceeds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
  })

  it('helper=true: message survives the tick unfailed and delivers on the next one', async () => {
    mockGetPendingMessages.mockReturnValue([pendingMsg(1)])
    mockIsReady.mockResolvedValue(false as never)
    mockClearModal.mockResolvedValue(true as never)

    await runMessageRouterTick()

    // The refusal branch actually reached the helper (no earlier gate turned
    // the caller back) ...
    expect(mockClearModal).toHaveBeenCalled()
    // ... and a cleared modal is neither a failure nor an instant delivery.
    expect(mockMarkFailed).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()

    // Next tick: the pane is ready, the SAME message goes out.
    mockIsReady.mockResolvedValue(true as never)
    await runMessageRouterTick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
  })

  it('negative control, helper=false: not-ready stays a skip, nothing delivers', async () => {
    mockGetPendingMessages.mockReturnValue([pendingMsg(2)])
    mockIsReady.mockResolvedValue(false as never)
    mockClearModal.mockResolvedValue(false as never)

    await runMessageRouterTick()

    expect(mockClearModal).toHaveBeenCalled()
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    // Held (not failed): the stuck bookkeeping owns this case, not failure.
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })
})
