// ROUTERSTUCK1012 (MODSPROBA1004): the ROUTER leg, driven end to end.
//
// router-stuck-alert.test.ts pins the pure decision and transcript-progress.test.ts
// the reader. What those cannot see is the wiring in runMessageRouterTick: at a
// busy escalation the router has to find the agent's transcript (its config
// root and encoded project dir), read it, and hand the answer to the decision.
// A router that skipped the read would pass every pure test and still send the
// 14 false alarms of 2026-10-05..10-11.
//
// The transcript files here are REAL files in a temp config root, written the
// way Claude Code lays them out: <config>/projects/<encoded agent dir>/<session>.jsonl.
// The pane is busy at every tick; ticks run 5 minutes apart for an hour.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeClaudeProjectDir } from '../claude-project-dir.js'

const SEP = '─'.repeat(80)
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

const ROOT = mkdtempSync(join(tmpdir(), 'rstuck-'))
const CFG = join(ROOT, 'cfg')
const agentDirOf = (name: string) => join(ROOT, 'agents', name)
const projectDirOf = (name: string) => join(CFG, 'projects', encodeClaudeProjectDir(agentDirOf(name)))

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
  readAgentRemoteHost: (name: string) => (name.startsWith('remote') ? 'build-host' : null),
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  isKnownAgent: () => true,
  agentDir: (name: string) => agentDirOf(name),
  readAgentWorksourceChannel: () => false,
}))

vi.mock('../web/claude-plans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/claude-plans.js')>()),
  resolveAgentConfigDirForRead: () => CFG,
}))

// Call-through spy: the real reader runs, and the test can count how often the
// router asked it (the healthy and not-busy paths must not ask at all).
vi.mock('../web/transcript-progress.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/transcript-progress.js')>()
  return { ...real, readTranscriptProgressAt: vi.fn(real.readTranscriptProgressAt) }
})

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

import { runMessageRouterTick, resetTranscriptProgressCacheForTests } from '../web/message-router.js'
import { readTranscriptProgressAt } from '../web/transcript-progress.js'

const MIN = 60 * 1000
let clock = 0
let seq = 0

const iso = (ms: number) => new Date(ms).toISOString()
const assistantAt = (ms: number) => JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }) + '\n'
const compactSummaryAt = (ms: number) => JSON.stringify({ type: 'user', timestamp: iso(ms), isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } }) + '\n'

function sessionFile(agent: string): string {
  const d = projectDirOf(agent)
  mkdirSync(d, { recursive: true })
  return join(d, 'sess-1.jsonl')
}

function pendingFor(agent: string) {
  return { id: 9100 + seq++, from_agent: 'marveen', to_agent: agent, content: 'queued behind a busy pane', status: 'pending', created_at: Math.floor(clock / 1000) }
}

function stuckAlerts(agent: string): string[] {
  return mockCreateAgentMessage.mock.calls
    .filter((c) => c[0] === 'system' && c[1] === 'orin' && String(c[2]).startsWith('[session-stuck]') && String(c[2]).includes(`'${agent}'`))
    .map((c) => String(c[2]))
}

// An hour of ticks 5 minutes apart on a busy pane. `beforeTick` runs before each
// tick (after the clock moved) so a test can make the agent write to its transcript.
async function busyHour(agent: string, beforeTick: (now: number) => void = () => {}) {
  mockGetPendingMessages.mockReturnValue([pendingFor(agent)])
  mockCapturePane.mockReturnValue(BUSY_PANE)
  for (let i = 0; i <= 12; i++) {
    if (i > 0) clock += 5 * MIN
    beforeTick(clock)
    await runMessageRouterTick()
  }
}

describe('router: a busy session whose transcript is moving is not reported as stuck (ROUTERSTUCK1012)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTranscriptProgressCacheForTests()
    clock = Date.UTC(2026, 9, 12, 9, 0, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('the measured shape: busy for an hour, the transcript moving every few minutes -> no alert', async () => {
    const f = sessionFile('working1')
    writeFileSync(f, '')
    await busyHour('working1', (now) => appendFileSync(f, assistantAt(now - 2 * MIN)))
    expect(stuckAlerts('working1')).toEqual([])
  })

  it('a real wedge still alerts: busy for an hour, the transcript silent since the start', async () => {
    const f = sessionFile('wedged1')
    writeFileSync(f, assistantAt(clock - MIN))
    await busyHour('wedged1')
    const alerts = stuckAlerts('wedged1')
    expect(alerts.length).toBeGreaterThanOrEqual(1)
    expect(alerts[0]).toContain('wedged1')
  })

  it('a compaction summary alone is not progress: a fresh summary over a silent turn still alerts', async () => {
    const f = sessionFile('compacted1')
    writeFileSync(f, assistantAt(clock - MIN))
    await busyHour('compacted1', (now) => appendFileSync(f, compactSummaryAt(now - MIN)))
    expect(stuckAlerts('compacted1').length).toBeGreaterThanOrEqual(1)
  })

  it('no transcript at all: today\'s rule (the busy watchdog alerts)', async () => {
    await busyHour('notranscript1')
    expect(stuckAlerts('notranscript1').length).toBeGreaterThanOrEqual(1)
  })

  it('a remote agent\'s transcript is not read: today\'s rule, even with a fresh local file under its name', async () => {
    const f = sessionFile('remote1')
    writeFileSync(f, '')
    await busyHour('remote1', (now) => appendFileSync(f, assistantAt(now - MIN)))
    expect(stuckAlerts('remote1').length).toBeGreaterThanOrEqual(1)
  })
})

describe('router: a live loop past the 2 h ceiling alerts, and says the transcript moved (ROUTERSTUCK1012)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTranscriptProgressCacheForTests()
    clock = Date.UTC(2026, 9, 13, 9, 0, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('busy for 2.5 h, the transcript written every 5 min: silent for 2 h, then exactly one MOZOG alert', async () => {
    const f = sessionFile('looper1')
    writeFileSync(f, '')
    mockGetPendingMessages.mockReturnValue([pendingFor('looper1')])
    mockCapturePane.mockReturnValue(BUSY_PANE)
    const start = clock
    const alertedAt: number[] = []
    for (let i = 0; i <= 30; i++) {
      if (i > 0) clock += 5 * MIN
      appendFileSync(f, assistantAt(clock - MIN))
      const before = stuckAlerts('looper1').length
      await runMessageRouterTick()
      if (stuckAlerts('looper1').length > before) alertedAt.push((clock - start) / MIN)
    }
    expect(alertedAt).toEqual([125])
    const [text] = stuckAlerts('looper1')
    expect(text).toContain('A transzkriptje közben MOZOG (utolsó haladás 1 perce)')
    expect(text).toContain('125 perce DOLGOZIK (busy)')
  })
})

describe('router: the transcript is read only where today\'s rule would alert a busy pane (ROUTERSTUCK1012)', () => {
  const PLAIN_NOT_READY_PANE = ['Some tool output that is not a prompt', '', SEP, '  loading…', SEP].join('\n')
  const reads = () => vi.mocked(readTranscriptProgressAt).mock.calls.length

  beforeEach(() => {
    vi.clearAllMocks()
    resetTranscriptProgressCacheForTests()
    clock = Date.UTC(2026, 9, 12, 12, 0, 0)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a not-busy pane escalates on today\'s rule without touching the transcript', async () => {
    const f = sessionFile('plain1')
    writeFileSync(f, assistantAt(clock))
    mockGetPendingMessages.mockReturnValue([pendingFor('plain1')])
    mockCapturePane.mockReturnValue(PLAIN_NOT_READY_PANE)
    await runMessageRouterTick()
    clock += 11 * MIN
    await runMessageRouterTick()
    expect(stuckAlerts('plain1')).toHaveLength(1)
    expect(reads()).toBe(0)
  })

  it('a busy pane under the 30 min watchdog is not read; past it, at most once a minute', async () => {
    const f = sessionFile('busyread1')
    writeFileSync(f, assistantAt(clock))
    mockGetPendingMessages.mockReturnValue([pendingFor('busyread1')])
    mockCapturePane.mockReturnValue(BUSY_PANE)
    await runMessageRouterTick()
    for (let m = 5; m <= 30; m += 5) { clock = Date.UTC(2026, 9, 12, 12, m, 0); await runMessageRouterTick() }
    expect(reads()).toBe(0)
    // Past the watchdog, with a transcript that keeps moving (so the router defers
    // and keeps re-checking instead of alerting and resetting its timer): three
    // ticks within one minute read once.
    appendFileSync(f, assistantAt(Date.UTC(2026, 9, 12, 12, 30, 30)))
    clock = Date.UTC(2026, 9, 12, 12, 31, 0); await runMessageRouterTick()
    clock += 20_000; await runMessageRouterTick()
    clock += 20_000; await runMessageRouterTick()
    expect(reads()).toBe(1)
    // ...and the answer is not kept longer than a minute: 61 s after the read, it reads again.
    clock = Date.UTC(2026, 9, 12, 12, 32, 1); await runMessageRouterTick()
    expect(reads()).toBe(2)
  })
})

process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* temp dir */ } })
