// Card 41a0c3a3: the ROUTER leg of the quota-wall class, driven end to end.
//
// quota-wall-pane.test.ts pins the detector and router-stuck-alert.test.ts the
// formatter and the cadence rule. What those cannot see is the wiring in
// runMessageRouterTick: at each stuck escalation the router has to read the
// pane for a wall, hand it to the notifier, and keep the per-agent record --
// a router that forgot the record would still pass every pure test while
// sending the same wall to the main agent every ten minutes.
//
// Measured on the live CLI of 2026-09-30 the walled pane reads IDLE and the
// readiness gate lets it through, so in production this path is reached only
// when a wall coincides with a not-ready pane. The mock below makes the pane
// not-ready on purpose: the unit under test is what the router does ONCE it
// escalates over a wall, not whether it escalates.
//
// Ticks run 11 minutes apart (past STUCK_ESCALATE_MS each time):
//   - wall pane, 2 h of escalations -> exactly ONE alert, with the reset time;
//   - permission pane, same ticks  -> an alert at EVERY escalation (unchanged);
//   - plain not-ready pane         -> an alert at every escalation (unchanged).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WALL_PANE = readFileSync(join(__dirname, 'fixtures/pane/quota-wall-usage-limit.txt'), 'utf8')
const PERMISSION_PANE = readFileSync(join(__dirname, 'fixtures/pane/permission-prompt-bash-grep.txt'), 'utf8')
const SEP = '─'.repeat(80)
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

function pendingFor(agent: string) {
  return {
    id: 7000 + seq++,
    from_agent: 'marveen',
    to_agent: agent,
    content: 'queued behind the pane',
    status: 'pending',
    created_at: Math.floor(clock / 1000),
  }
}

// One tick to start the stuck clock, then `escalations` ticks 11 minutes apart.
async function escalateOver(agent: string, pane: string, escalations: number) {
  mockGetPendingMessages.mockReturnValue([pendingFor(agent)])
  mockCapturePane.mockReturnValue(pane)
  await runMessageRouterTick()
  for (let i = 0; i < escalations; i++) {
    clock += 11 * 60 * 1000
    await runMessageRouterTick()
  }
}

function stuckAlerts(agent: string): string[] {
  return mockCreateAgentMessage.mock.calls
    .filter((c) => c[0] === 'system' && c[1] === 'orin' && String(c[2]).startsWith('[session-stuck]') && String(c[2]).includes(`'${agent}'`))
    .map((c) => String(c[2]))
}

describe('router: a stuck session at the plan usage limit is reported once per wall', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clock = Date.UTC(2026, 8, 30, 16, 0, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('two hours of escalations over the same wall send ONE alert, carrying the reset time', async () => {
    await escalateOver('wallbind1', WALL_PANE, 11)
    const alerts = stuckAlerts('wallbind1')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('PLAN USAGE LIMIT')
    expect(alerts[0]).toContain('resumes by itself at 6:20pm')
    expect(alerts[0]).not.toContain('restart the agent if it is wedged')
    // The router read the pane at each escalation, it did not stop looking.
    expect(mockCapturePane.mock.calls.filter((c) => c[0] === 'agent-wallbind1').length).toBeGreaterThanOrEqual(11)
  })

  // TESTFOLLOWUP1007G (the #1737 review's surviving mutant): only an ALERT may
  // stamp the per-agent wall record. If a 'silent' step stamped it too, every
  // escalation over the same wall (11 min apart, under the 30 min gap) would
  // push the gap forward, and a NEW wall would never be alerted. Wall A is
  // alerted at the first escalation and stays quiet at +11 and +22 min; at +33
  // min the pane shows wall B (another reset time): 33 min after the only
  // alert, past the gap, and a different key -- so it must be alerted.
  it('a new wall after the gap is alerted even when the old wall was silent in between', async () => {
    const WALL_B_PANE = WALL_PANE.replace(/6:20pm/g, '11:20pm')
    await escalateOver('wallbind4', WALL_PANE, 3)
    expect(stuckAlerts('wallbind4')).toHaveLength(1)
    mockCapturePane.mockReturnValue(WALL_B_PANE)
    clock += 11 * 60 * 1000
    await runMessageRouterTick()
    const alerts = stuckAlerts('wallbind4')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]).toContain('resumes by itself at 6:20pm')
    expect(alerts[1]).toContain('resumes by itself at 11:20pm')
  })

  it('control: a permission prompt keeps today\'s cadence -- an alert at every escalation', async () => {
    await escalateOver('wallbind2', PERMISSION_PANE, 4)
    const alerts = stuckAlerts('wallbind2')
    expect(alerts).toHaveLength(4)
    for (const a of alerts) expect(a).toContain('TOOL-PERMISSION PROMPT')
  })

  it('control: a plain not-ready pane keeps the not-ready alert at every escalation', async () => {
    await escalateOver('wallbind3', PLAIN_NOT_READY_PANE, 3)
    const alerts = stuckAlerts('wallbind3')
    expect(alerts).toHaveLength(3)
    for (const a of alerts) {
      expect(a).toContain('not-ready')
      expect(a).not.toContain('PLAN USAGE LIMIT')
    }
  })
})
