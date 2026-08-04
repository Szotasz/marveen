/**
 * Delivery-intent gate for bareEnterRecovery (remote sub-agent path).
 *
 * Verifies that a bare Enter is held when the parked plain text cannot be
 * attributed to a genuine delivery, and proceeds when it can.
 * Complete <channel> blocks are exempt (structural chat_id verification).
 *
 * Privacy: no real agent or session names.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks -- set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

const mockSendEnter = vi.fn()
const mockCaptureParkedInputView = vi.fn<() => string | null>()
const mockStuckInputSignature = vi.fn<(pane: string) => string | null>()
const mockParkedPasteSignature = vi.fn<(pane: string) => string | null>(() => null)
const mockDecideStuckInputRecovery = vi.fn()
const mockParkedChannelInput = vi.fn<() => { complete: boolean; block: string | null; chatId: string | null } | null>()
const mockParkedInputText = vi.fn<() => string | null>()
const mockMatchDelivery = vi.fn<() => boolean>()

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    captureParkedInputView: mockCaptureParkedInputView,
    sendEnterToSession: mockSendEnter,
    isAgentRunning: vi.fn(() => false),
  }
})

vi.mock('../pane-state.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    stuckInputSignature: mockStuckInputSignature,
    parkedPasteSignature: mockParkedPasteSignature,
    parkedChannelInput: mockParkedChannelInput,
    parkedInputText: mockParkedInputText,
    decideStuckInputRecovery: mockDecideStuckInputRecovery,
  }
})

vi.mock('../web/delivery-intent.js', () => ({
  recordDelivery: vi.fn(),
  matchDelivery: mockMatchDelivery,
  clearDeliveries: vi.fn(),
  _registrySize: vi.fn(() => 0),
}))

// Additional required stubs so the module loads.
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    MAIN_AGENT_ID: 'main',
    SERVICE_ID: 'test',
    BOT_NAME: 'testbot',
    CHANNEL_PROVIDER: 'telegram',
    PROJECT_ROOT: '/tmp',
    RESPAWN_ENABLED: false,
    WEB_PORT: 3420,
  }
})
vi.mock('./agent-config.js', () => ({
  listAgentNames: vi.fn(() => []),
  readAgentRemoteHost: vi.fn(() => null),
  agentDir: vi.fn(() => '/tmp/agent'),
}))
vi.mock('./channel-mcp-reconnect.js', () => ({
  resolveAgentSession: vi.fn((name: string) => `${name}-session`),
}))
vi.mock('./main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'main-channels',
}))
vi.mock('./channel-monitor.js', () => ({
  recoverStuckInputForSession: vi.fn(),
  sendAlert: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

const { _bareEnterRecovery } = await import('../web/stuck-input-watcher.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION = 'agent-b-remote-session'
const HOST = 'remote-host'

function setupRecover(pane: string | null) {
  mockCaptureParkedInputView.mockReturnValue(pane)
  mockStuckInputSignature.mockReturnValue(pane != null ? 'sig-x' : null)
  mockDecideStuckInputRecovery.mockReturnValue({
    recover: pane != null,
    next: { parkedSig: pane != null ? 'sig-x' : null, firstSeenAt: 1000, lastRecoverAt: 2000, attempts: 1 },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockParkedChannelInput.mockReturnValue(null)
  mockParkedInputText.mockReturnValue(null)
  mockMatchDelivery.mockReturnValue(false)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bareEnterRecovery -- delivery-intent gate', () => {
  it('holds the bare Enter when plain text is NOT attributed to a delivery', () => {
    setupRecover('pane with unattributed plain text')
    mockParkedChannelInput.mockReturnValue(null)           // no channel block
    mockParkedInputText.mockReturnValue('inter-agent msg') // plain text parked
    mockMatchDelivery.mockReturnValue(false)               // NOT a known delivery

    _bareEnterRecovery('agent-b', SESSION, HOST)

    expect(mockSendEnter).not.toHaveBeenCalled()
    expect(mockMatchDelivery).toHaveBeenCalledWith(SESSION, 'inter-agent msg')
  })

  it('sends the bare Enter when plain text IS attributed to a delivery', () => {
    setupRecover('pane with delivery-matched plain text')
    mockParkedChannelInput.mockReturnValue(null)
    mockParkedInputText.mockReturnValue('scheduled task content')
    mockMatchDelivery.mockReturnValue(true)

    _bareEnterRecovery('agent-b', SESSION, HOST)

    expect(mockSendEnter).toHaveBeenCalledWith(SESSION, HOST)
  })

  it('sends the bare Enter for a complete <channel> block (exempt from gate)', () => {
    setupRecover('pane with complete channel block')
    mockParkedChannelInput.mockReturnValue({
      complete: true,
      block: '<channel source="test" chat_id="999">hello</channel>',
      chatId: '999',
    })
    // matchDelivery is NOT called for block-complete (gate is exempt)
    mockMatchDelivery.mockReturnValue(false)

    _bareEnterRecovery('agent-b', SESSION, HOST)

    expect(mockSendEnter).toHaveBeenCalledWith(SESSION, HOST)
    expect(mockMatchDelivery).not.toHaveBeenCalled()
  })

  it('does not send Enter when pane capture fails (null pane)', () => {
    setupRecover(null) // recover=false when pane is null
    _bareEnterRecovery('agent-b', SESSION, HOST)
    expect(mockSendEnter).not.toHaveBeenCalled()
  })

  it('sends Enter when plain text is null (no content to check -- gate does not apply)', () => {
    // parkedInputText=null means there is no collapsed plain text in the box
    // (e.g. empty box or a format the parser does not collapse). The gate
    // condition requires plainText != null to hold, so an Enter proceeds.
    setupRecover('pane with empty/unrecognised content')
    mockParkedChannelInput.mockReturnValue(null)
    mockParkedInputText.mockReturnValue(null) // no plain text
    mockMatchDelivery.mockReturnValue(false)

    _bareEnterRecovery('agent-b', SESSION, HOST)

    expect(mockSendEnter).toHaveBeenCalledWith(SESSION, HOST)
  })

  it('ignores an incomplete (truncated) channel block -- gate applies to its plain text', () => {
    setupRecover('pane with truncated block')
    mockParkedChannelInput.mockReturnValue({
      complete: false,           // TRUNCATED -- not exempt
      block: null,
      chatId: null,
    })
    mockParkedInputText.mockReturnValue('truncated content shown in box')
    mockMatchDelivery.mockReturnValue(false)

    _bareEnterRecovery('agent-b', SESSION, HOST)

    // Truncated block is not exempt; unmatched plain text -> hold
    expect(mockSendEnter).not.toHaveBeenCalled()
  })
})
