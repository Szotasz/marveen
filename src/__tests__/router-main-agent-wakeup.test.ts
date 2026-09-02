// Contract test: the message router must NOT type a blind wakeup into the
// main agent's channels session.
//
// Root cause: inter-agent messages addressed to the main agent stayed
// 'pending' while the router fired
// `sendPromptToSession(..., { waitForIdle: false })` at the channels pane once
// per MAIN_AGENT_WAKEUP_COOLDOWN_MS, logging "main-agent wakeup fired" on every
// retry. The pane was mid-turn, so each wakeup landed as a queued mid-turn message
// instead of a fresh prompt submit -- no UserPromptSubmit, therefore no
// drain-inbox call, therefore no claim. The rows stayed pending, the cooldown
// re-armed, and the loop burned five main-agent turns without delivering
// anything.
//
// Main-agent wakeups belong to the inbox-nudge-watcher (added later, #557),
// which fires ONLY on double-capture-confirmed idle, aborts if the pane turns
// busy in the gap, escalates a stale spell and finally alerts the owner. The
// router's older, undisciplined duplicate is what looped.
//
// The invariant pinned here: whatever the router does with a main-agent
// message, it never drives the main channels session.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockSendPromptToSession = vi.fn(async (..._a: unknown[]) => {})
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)

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
    if (toAgent) return [] // per-agent query for the reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (..._a: unknown[]) => true,
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => true,
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
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  // The channels pane is mid-turn -- the exact state of the incident.
  isSessionReadyForPrompt: vi.fn(async () => false),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPromptToSession(...a),
  sessionExistsOnHost: vi.fn(() => true),
  capturePane: vi.fn(async () => ''),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'dex' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))

import { runMessageRouterTick } from '../web/message-router.js'

function pendingToMain(id: number) {
  return {
    id,
    from_agent: 'dex',
    to_agent: 'orin', // MAIN_AGENT_ID -> the PULL path
    content: 'ping',
    created_at: Math.floor(Date.now() / 1000),
  }
}

describe('router main-agent wakeup loop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendPromptToSession.mockResolvedValue(undefined)
  })

  it('never drives the main channels session for a pending main-agent message', async () => {
    mockGetPendingMessages.mockReturnValue([pendingToMain(1)])

    await runMessageRouterTick()

    // The incident: this call happened, into a busy pane, with waitForIdle:false.
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('does not re-fire across cooldown windows while the same message stays pending', async () => {
    // The message stayed pending for four consecutive cooldown windows and
    // each one produced another injection.
    // The router's cooldown is module state keyed on Date.now(), so the clock
    // must actually move for this to reproduce the loop rather than the
    // (order-dependent) single-window case above.
    const created = Math.floor(Date.now() / 1000)
    mockGetPendingMessages.mockReturnValue([{
      id: 1, from_agent: 'dex', to_agent: 'orin', content: 'ping', created_at: created,
    }])
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 4; i++) {
        vi.setSystemTime(created * 1000 + i * 46_000) // past MAIN_AGENT_WAKEUP_COOLDOWN_MS (45s)
        await runMessageRouterTick()
      }
    } finally {
      vi.useRealTimers()
    }

    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('leaves the main-agent message pending for the drain to claim', async () => {
    // The router must not fail/consume it either: the PULL path (drain-inbox
    // + inbox-nudge-watcher) owns the row.
    mockGetPendingMessages.mockReturnValue([pendingToMain(1)])

    await runMessageRouterTick()

    expect(mockMarkFailed).not.toHaveBeenCalled()
  })
})
