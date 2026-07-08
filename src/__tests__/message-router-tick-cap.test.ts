// Contract test for the per-tick work cap in the message router.
//
// runMessageRouterTick() must process AT MOST MAX_MESSAGES_PER_TICK pending
// messages per pass, rolling any backlog to the next tick. This bounds a single
// tick's wall-time so a large pending backlog (e.g. after a delivery stall) can
// never make one tick run long and starve the event loop -- the slow-tick half
// of the progressive-hang pattern.
//
// We feed 30 pending messages, all addressed to a SUB-agent whose tmux session
// does not exist, and assert sessionExistsOnHost -- the first per-message probe
// past the main-agent skip -- fires exactly MAX_MESSAGES_PER_TICK (25) times.
// The remaining 5 are left untouched for the next tick.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => false)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'orin',
}))

vi.mock('../db.js', () => ({
  getPendingMessages: () => mockGetPendingMessages(),
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
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

    // Each processed message probes sessionExistsOnHost exactly once before the
    // absent-session `continue`; the 5-message backlog is never touched.
    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(MAX_MESSAGES_PER_TICK)
  })

  it('processes all messages when the backlog is under the cap', async () => {
    mockGetPendingMessages.mockReturnValue(makePending(10))

    await runMessageRouterTick()

    expect(mockSessionExistsOnHost).toHaveBeenCalledTimes(10)
  })
})
