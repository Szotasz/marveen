// PR1166BEKOTES923: the ROUTER leg of #1166, driven end to end.
//
// #1166 taught formatStuckSessionAlert to say "TOOL-PERMISSION PROMPT -- answer
// it, do not restart, do not send a blind Escape", and its own tests pin the
// formatter and the pane detector. What no test covered was the wiring in
// runMessageRouterTick: at the stuck escalation the router has to ASK the pane
// whether it is a permission prompt and hand that verdict (and the question it
// quotes) to the notifier. Measured on the merged tree (Geri, PR50SWEEP925): a
// mutant where the router never recognises the prompt (K1), or recognises it
// but does not pass the flag on (K5), left the whole suite green -- the main
// agent would have been told "restart it if it is wedged" about a session that
// only needed a yes/no, which is the exact failure #1166 exists to prevent.
//
// So this drives two real router ticks over the real #1166 pane fixture:
//   tick 1: session exists and is not ready -> the stuck clock starts;
//   tick 2: 11 min later -> escalation; the alert that reaches the main agent's
//           inbox must carry the TOOL-PERMISSION PROMPT framing and the quoted
//           question, and must NOT carry the restart advice.
// Negative control: a not-ready pane that is NOT a permission prompt still gets
// the old not-ready text -- so the assertion is about the pane, not a constant.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PERMISSION_PANE = readFileSync(join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'), 'utf8')
const SEP = '─'.repeat(80)
// Not ready, not busy, not a permission prompt: a pane the detector reads as
// unknown -- the case the plain "not-ready ... restart if wedged" text is for.
const PLAIN_NOT_READY_PANE = ['Some tool output that is not a prompt', '', SEP, '  loading…', SEP].join('\n')

const mockGetPendingMessages = vi.fn()
const mockCreateAgentMessage = vi.fn((..._a: unknown[]) => ({ id: 999 }))
const mockCapturePane = vi.fn((..._a: unknown[]): string | null => null)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : mockGetPendingMessages()),
  getMessageStatus: (..._a: unknown[]) => 'pending',
  markMessageDelivered: (..._a: unknown[]) => true,
  markMessageFailed: (..._a: unknown[]) => true,
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => 0,
  setMessageResult: (..._a: unknown[]) => true,
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
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
  isKnownAgent: () => true,
  agentDir: () => '/tmp/none-agentdir',
  // A worksource agent skips the readiness gate; this file measures that gate.
  readAgentWorksourceChannel: () => false,
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => false),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: vi.fn(() => true),
  capturePane: (...a: unknown[]) => mockCapturePane(...a),
  clearFeedbackModalAndRecheck: vi.fn(async () => false),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

import { runMessageRouterTick } from '../web/message-router.js'

let clock = 0
let seq = 0

// A fresh recipient per test: the router keeps its stuck clock in module state
// keyed by agent, so reusing a name would carry one test's clock into the next.
function pendingFor(agent: string) {
  return {
    id: 5000 + seq++,
    from_agent: 'marveen',
    to_agent: agent,
    content: 'queued behind the prompt',
    status: 'pending',
    created_at: Math.floor(clock / 1000),
  }
}

async function twoTicksElevenMinutesApart(agent: string, pane: string) {
  mockGetPendingMessages.mockReturnValue([pendingFor(agent)])
  mockCapturePane.mockReturnValue(pane)
  await runMessageRouterTick() // stuck clock starts
  clock += 11 * 60 * 1000
  await runMessageRouterTick() // past STUCK_ESCALATE_MS -> escalation
}

// The alerts the router surfaced to the main agent, from the system sender.
function stuckAlerts(): string[] {
  return mockCreateAgentMessage.mock.calls
    .filter((c) => c[0] === 'system' && c[1] === 'orin' && String(c[2]).startsWith('[session-stuck]'))
    .map((c) => String(c[2]))
}

describe('router: a stuck session on a permission prompt is reported as a question, not a wedge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clock = Date.UTC(2026, 8, 25, 16, 0, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('the escalated alert carries TOOL-PERMISSION PROMPT and the quoted question, not the restart advice', async () => {
    await twoTicksElevenMinutesApart('permbind1', PERMISSION_PANE)
    const alerts = stuckAlerts()
    expect(alerts).toHaveLength(1)
    const a = alerts[0]
    expect(a).toContain("'permbind1'")
    expect(a).toContain('TOOL-PERMISSION PROMPT')
    // The router passed the pane's summary through, not just the flag.
    expect(a).toContain('It asks:')
    expect(a).toContain('Do NOT restart')
    expect(a).not.toContain('restart the agent if it is wedged')
  })

  it('negative control: a not-ready pane that is NOT a prompt keeps the plain not-ready alert', async () => {
    await twoTicksElevenMinutesApart('permbind2', PLAIN_NOT_READY_PANE)
    const alerts = stuckAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('not-ready')
    expect(alerts[0]).not.toContain('TOOL-PERMISSION PROMPT')
  })

  it('the pane is read at the escalation (the verdict comes from the pane, not a constant)', async () => {
    await twoTicksElevenMinutesApart('permbind3', PERMISSION_PANE)
    expect(mockCapturePane).toHaveBeenCalledWith('agent-permbind3', null)
  })
})
