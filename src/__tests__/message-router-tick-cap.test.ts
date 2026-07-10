// Contract test for the per-tick work cap in the message router.
//
// runMessageRouterTick() must process AT MOST MAX_MESSAGES_PER_TICK pending
// messages per pass, rolling any backlog to the next tick. This bounds a single
// tick's wall-time so a large pending backlog (e.g. after a delivery stall) can
// never make one tick run long and starve the event loop -- the slow-tick half
// of the progressive-hang pattern.
//
// Since card 2922e380, sessionExistsOnHost is called once per unique receiver
// in the pre-pass and cached for the main loop (not once per message). The work
// cap is verified by the slice() bound: at most MAX_MESSAGES_PER_TICK messages
// enter the loop per tick, regardless of backlog size.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => false)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query for reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(() => false),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { runMessageRouterTick, MAX_MESSAGES_PER_TICK } from '../web/message-router.js'

function makePending(count: number) {
  const nowSec = Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    from_agent: 'orin',
    to_agent: 'dex', // SUB-agent, not MAIN_AGENT_ID -> takes the tmux-inject path
    content: 'ping',
    created_at: nowSec, // fresh -> well inside the abandon window
  }))
}

describe('message router per-tick work cap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(false)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
  })

  it('processes at most MAX_MESSAGES_PER_TICK messages in one tick', async () => {
    expect(MAX_MESSAGES_PER_TICK).toBe(25)
    mockGetPendingMessages.mockReturnValue(makePending(30))

    await runMessageRouterTick()

    // sessionExistsOnHost is called once per unique receiver (cached since card 2922e380).
    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(1)
    // Messages are fresh (within abandon window) and session is absent, so they
    // are NOT marked failed — they remain pending for the next tick.
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('processes all messages when the backlog is under the cap', async () => {
    mockGetPendingMessages.mockReturnValue(makePending(10))

    await runMessageRouterTick()

    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })
})
