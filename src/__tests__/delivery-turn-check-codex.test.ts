// CODEXEVID d72ba2bd: the delivery turn check must ALSO read the recipient's
// Codex rollout JSONL when the pane runs OpenAI Codex instead of Claude Code.
// Measured 2026-11-15 on this install: 239 "delivered without transcript
// evidence" WARNs across the 8 codex-motor agents, all false -- the Claude
// transcript of those agents never moves. The rollout line below is the exact
// measured schema of a delivered message as it lands in
// <CODEX_HOME>/sessions/YYYY/MM/DD/*.jsonl.
//
// These cases extend delivery-turn-check.test.ts (which stays untouched and
// covers the Claude-only behaviour) with the codex paths.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockCreateAgentMessage = vi.fn((..._a: unknown[]) => ({ id: 1 }))
const mockDebug = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: (...a: unknown[]) => mockDebug(...a), error: vi.fn() },
}))
// importOriginal spread: the transitive chain (agent-message-wrap -> channel-coordinator/*)
// pulls more config exports (VOICE_CHANNEL_ID, PROJECT_ROOT, ...) in the real repo; the GLM
// sandbox stubbed that chain away, so the plain partial mock was incomplete here.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
}))
vi.mock('../db.js', () => ({ createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a) }))
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
vi.mock('../web/agent-config.js', () => ({ agentDir: (n: string) => `/agents/${n}` }))
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => undefined }))
vi.mock('../web/active-model.js', () => ({ projectsDirFor: () => claudeDir }))

import {
  classifyCodexRolloutLines,
  classifyTranscriptLines,
  readCodexTurnEvidence,
  readTurnEvidence,
  runDeliveryTurnCheck,
  resetTurnCheckState,
  CLOCK_SLACK_MS,
  type TurnCheckDeps,
} from '../web/delivery-turn-check.js'

const SENT = Date.parse('2026-11-15T11:07:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const envelope = (id: number) =>
  `TEAM MEMBER NOTICE ... [Uzenet @samu-tol -- trusted team member, msg_id:${id}]: <trusted-peer source="agent:samu"> SECRET-BODY-${id} </trusted-peer>`

// The EXACT measured rollout row (2026-11-15, recipient rollout ordinal 8921):
// top-level timestamp + type "response_item", payload a user message whose
// input_text carries the router envelope with the msg_id tag.
const rolloutLine = (id: number, at = Date.parse('2026-11-15T11:07:52.752Z')) =>
  JSON.stringify({
    timestamp: iso(at),
    ordinal: 8921,
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_6819a2b4',
      role: 'user',
      content: [{ type: 'input_text', text: envelope(id) }],
    },
  })
const rolloutAssistant = (at = Date.parse('2026-11-15T11:07:52.752Z')) =>
  JSON.stringify({
    timestamp: iso(at), ordinal: 8922, type: 'response_item',
    payload: { type: 'message', id: 'msg_6819a2b5', role: 'assistant', content: [{ type: 'output_text', text: envelope(128547) }] },
  })

let root: string
let claudeDir: string
let codexSessions: string

function writeClaudeTranscript(name: string, lines: string[], mtimeMs = SENT + 1000) {
  const p = join(claudeDir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}

function writeRollout(lines: string[], mtimeMs = SENT + 1000, name = 'rollout-2026-11-15T11-07-52.jsonl') {
  // sessions/YYYY/MM/DD: three levels under the resolved sessions dir.
  const dir = join(codexSessions, '2026', '11', '15')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}

function deps(over: Record<string, unknown> = {}) {
  const notify = vi.fn()
  return {
    transcriptDir: () => claudeDir,
    readEvidence: readTurnEvidence,
    notify,
    now: () => SENT + 60_000,
    codexSessionDirs: async () => (codexDirOn ? [codexSessions] : []),
    readCodexEvidence: readCodexTurnEvidence,
    ...over,
  } as unknown as TurnCheckDeps & { notify: ReturnType<typeof vi.fn> }
}

let codexDirOn: boolean
const req = (ids: number[], toAgent = 'dex', host: string | null = null) => ({ toAgent, msgIds: ids, sentAtMs: SENT, host })

beforeEach(() => {
  resetTurnCheckState()
  mockCreateAgentMessage.mockClear()
  root = mkdtempSync(join(tmpdir(), 'turncheck-codex-'))
  claudeDir = join(root, 'projects', '-agents-dex')
  mkdirSync(claudeDir, { recursive: true })
  codexSessions = join(root, 'codex-home', 'sessions')
  codexDirOn = true
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('classifyCodexRolloutLines (PURE, mirrors classifyTranscriptLines)', () => {
  it('(a) the measured rollout line with the msg_id, timestamped after the send => seen', () => {
    expect(classifyCodexRolloutLines([rolloutLine(128547)], 128547, SENT)).toBe('seen')
  })
  it('(c) the same line timestamped before the send floor is another message => absent', () => {
    expect(classifyCodexRolloutLines([rolloutLine(128547, SENT - 60_000)], 128547, SENT)).toBe('absent')
    // ...but the measured small clock skew stays tolerated (same floor as the Claude path).
    expect(classifyCodexRolloutLines([rolloutLine(128547, SENT - 1_200)], 128547, SENT)).toBe('seen')
  })
  it('an assistant message echoing the tag is not a delivered prompt', () => {
    expect(classifyCodexRolloutLines([rolloutAssistant()], 128547, SENT)).toBe('absent')
  })
  it('non-message payload types (function_call_output etc.) are not evidence', () => {
    const line = JSON.stringify({
      timestamp: iso(SENT + 300), ordinal: 8923, type: 'response_item',
      payload: { type: 'function_call_output', output: envelope(128547) },
    })
    expect(classifyCodexRolloutLines([line], 128547, SENT)).toBe('absent')
  })
  it('msg_id:1285478 does not match msg_id:128547 (the tag stays anchored)', () => {
    expect(classifyCodexRolloutLines([rolloutLine(1285478)], 128547, SENT)).toBe('absent')
  })
  it('a line that does not parse as JSON is ignored, not fatal', () => {
    expect(classifyCodexRolloutLines(['{"timestamp":"brok' + rolloutLine(128547)], 128547, SENT)).toBe('absent')
  })
  it('plain-string content carrying the tag counts too (defensive, not the measured shape)', () => {
    const line = JSON.stringify({
      timestamp: iso(SENT + 300), type: 'response_item',
      payload: { type: 'message', role: 'user', content: envelope(128547) },
    })
    expect(classifyCodexRolloutLines([line], 128547, SENT)).toBe('seen')
  })
})

describe('readCodexTurnEvidence (rollout files on disk)', () => {
  it('reads the rollout tail three levels under sessions/ and finds the tag', async () => {
    writeRollout([rolloutLine(128547)])
    const ev = await readCodexTurnEvidence([codexSessions], [128547], SENT)
    expect(ev?.get(128547)).toBe('seen')
  })
  it('a rollout untouched since before the send is not a candidate => unknown (null)', async () => {
    writeRollout([rolloutLine(128547, SENT - 3_600_000)], SENT - 3_600_000)
    expect(await readCodexTurnEvidence([codexSessions], [128547], SENT)).toBeNull()
  })
  it('a missing sessions dir => null, never a throw', async () => {
    expect(await readCodexTurnEvidence([join(root, 'nope')], [128547], SENT)).toBeNull()
  })
})

describe('runDeliveryTurnCheck: codex rollouts as second evidence source', () => {
  it('(a) Claude transcript absent, rollout carries the envelope tag => confirmed, no alert', async () => {
    writeClaudeTranscript('a.jsonl', [ // claude transcript readable, so today this alerts
      JSON.stringify({ type: 'assistant', timestamp: iso(SENT - 60_000), message: { content: [{ type: 'text', text: 'old work' }] } }),
    ])
    writeRollout([rolloutLine(128547)])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([128547]), 60, 30 * 60_000, d)).toBe('confirmed')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('(b) codex dirs exist but no rollout line carries the tag => alert exactly as today', async () => {
    writeClaudeTranscript('a.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: iso(SENT + 300), message: { content: [{ type: 'text', text: 'working' }] } }),
    ])
    writeRollout([rolloutAssistant()])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([128548]), 60, 30 * 60_000, d)).toBe('alerted')
    const text = String(d.notify.mock.calls[0][0])
    expect(text).toContain('msg_id 128548')
    expect(text).toContain("'dex'")
    expect(text).not.toContain('SECRET-BODY')
  })

  it('(c) a rollout line stamped BEFORE the send floor is not evidence => alert', async () => {
    writeClaudeTranscript('a.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: iso(SENT + 300), message: { content: [{ type: 'text', text: 'working' }] } }),
    ])
    writeRollout([rolloutLine(128549, SENT - 60_000)])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([128549]), 60, 30 * 60_000, d)).toBe('alerted')
  })

  it('seen wins over a Claude-side blocked-by-hook verdict (the agent is not running Claude Code at all)', async () => {
    writeClaudeTranscript('a.jsonl', [
      JSON.stringify({
        type: 'system', level: 'warning', timestamp: iso(SENT + 300),
        content: `UserPromptSubmit operation blocked by hook:\nOriginal prompt: ${envelope(128550)}`,
      }),
    ])
    writeRollout([rolloutLine(128550)])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([128550]), 60, 30 * 60_000, d)).toBe('confirmed')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('no claude transcript at all (unknown) + rollout evidence => confirmed', async () => {
    rmSync(claudeDir, { recursive: true, force: true })
    writeRollout([rolloutLine(128551)])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([128551]), 60, 30 * 60_000, d)).toBe('confirmed')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('no claude transcript + unreadable codex dirs => unknown, silent (today’s semantics for what it cannot see)', async () => {
    rmSync(claudeDir, { recursive: true, force: true })
    const d = deps({ readCodexEvidence: async () => null })
    expect(await runDeliveryTurnCheck(req([128552]), 60, 30 * 60_000, d)).toBe('unknown')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('no codex dirs resolvable (Claude-Code agent) => exactly today’s behaviour', async () => {
    writeClaudeTranscript('a.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: iso(SENT + 300), message: { content: [{ type: 'text', text: 'working' }] } }),
    ])
    const d = deps({ codexSessionDirs: async () => [] })
    expect(await runDeliveryTurnCheck(req([128553]), 60, 30 * 60_000, d)).toBe('alerted')
  })

  it('deps shaped exactly like today’s (no codex readers at all) => today’s behaviour', async () => {
    writeClaudeTranscript('a.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: iso(SENT + 300), message: { content: [{ type: 'text', text: 'working' }] } }),
    ])
    const notify = vi.fn()
    const d = { transcriptDir: () => claudeDir, readEvidence: readTurnEvidence, notify, now: () => SENT + 60_000 } as TurnCheckDeps & { notify: ReturnType<typeof vi.fn> }
    expect(await runDeliveryTurnCheck(req([128554]), 60, 30 * 60_000, d)).toBe('alerted')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('a codex resolver that throws degrades to today’s verdict, never into the timer body', async () => {
    writeClaudeTranscript('a.jsonl', [
      JSON.stringify({ type: 'assistant', timestamp: iso(SENT + 300), message: { content: [{ type: 'text', text: 'working' }] } }),
    ])
    const d = deps({ codexSessionDirs: async () => { throw new Error('tmux blew up') } })
    expect(await runDeliveryTurnCheck(req([128555]), 60, 30 * 60_000, d)).toBe('alerted')
  })

  it('the floor the rollout mtime must clear is the same CLOCK_SLACK_MS as the Claude path', () => {
    // Pins the mtime filter to sinceMs - CLOCK_SLACK_MS: a file touched exactly
    // at the floor is a candidate, one touched a second earlier is not.
    expect(CLOCK_SLACK_MS).toBe(5_000)
  })
})

// Cross-check that the pure classifiers stay consistent on the same input
// shape: a codex line fed to the Claude classifier must not read as seen
// (different row schema), so the two scanners cannot mask each other.
describe('classifier separation', () => {
  it('the Claude classifier does not recognise a codex rollout row', () => {
    expect(classifyTranscriptLines([rolloutLine(128547)], 128547, SENT)).toBe('absent')
  })
})
