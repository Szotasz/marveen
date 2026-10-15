// ROUTERSAWTURN824: behaviour of the post-delivery transcript check, against
// REAL transcript files in a temp directory (the rows are shaped like the ones
// measured in live transcripts on 2026-10-08: a typed user prompt, a
// queued_command attachment + queue enqueue for a prompt typed into a busy
// pane, and the system row Claude Code writes when a UserPromptSubmit hook
// blocks the prompt).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockCreateAgentMessage = vi.fn((..._a: unknown[]) => ({ id: 1 }))

const mockDebug = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: (...a: unknown[]) => mockDebug(...a), error: vi.fn() },
}))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
}))
vi.mock('../db.js', () => ({
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
}))
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
// The default transcript resolver, pointed at the temp dir of each test.
vi.mock('../web/agent-config.js', () => ({ agentDir: (n: string) => `/agents/${n}` }))
// `isolatedCfg` set = the agent has an isolated config root (its projects dir is
// `isolatedDir`); `dir` is then the shared ~/.claude/projects/<slug> one.
vi.mock('../web/main-transcript-root.js', () => ({ configDirFor: () => isolatedCfg }))
vi.mock('../web/active-model.js', () => ({
  projectsDirFor: (_wd: string, cfg?: string) => (cfg ? isolatedDir : dir),
}))

// Real fs work runs on libuv, not on the faked timers: poll with setImmediate
// until `done` holds, bounded by REAL time (performance.now is not faked). A
// fixed iteration count passed locally and failed on the slower CI runner,
// where the check then finished inside the NEXT test (run 37740338953).
async function settle(done: () => boolean, budgetMs = 10_000) {
  const end = performance.now() + budgetMs
  while (!done() && performance.now() < end) await new Promise((r) => setImmediate(r))
}
const debugSaid = (text: string) => () => mockDebug.mock.calls.some((c) => String(c[1] ?? '').includes(text))

import {
  classifyTranscriptLines,
  readTurnEvidence,
  runDeliveryTurnCheck,
  scheduleDeliveryTurnCheck,
  resetTurnCheckState,
  formatUnconfirmedAlert,
  graceSecFrom,
  alertWindowMsFrom,
  type TurnCheckDeps,
} from '../web/delivery-turn-check.js'

const SENT = Date.parse('2026-10-08T08:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const envelope = (id: number) =>
  `TEAM MEMBER NOTICE ... [Uzenet @samu-tol -- trusted team member, msg_id:${id}]: <trusted-peer source="agent:samu"> SECRET-BODY-${id} </trusted-peer>`

const userPrompt = (id: number, at = SENT + 300) =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: envelope(id) } })
const queued = (id: number, at = SENT + 300) => [
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), content: envelope(id) }),
  JSON.stringify({ type: 'attachment', timestamp: iso(at + 5000), attachment: { type: 'queued_command', prompt: envelope(id) } }),
].join('\n')
const attachmentOnly = (id: number, at = SENT + 300) =>
  JSON.stringify({ type: 'attachment', timestamp: iso(at), attachment: { type: 'queued_command', prompt: envelope(id) } })
const blocked = (id: number, at = SENT + 300) =>
  JSON.stringify({
    type: 'system', subtype: 'informational', level: 'warning', timestamp: iso(at),
    content: `UserPromptSubmit operation blocked by hook:\n[/usr/bin/python3 /hooks/x.py]: Traceback ...\n\nOriginal prompt: ${envelope(id)}`,
  })
const toolResultMentioning = (id: number, at = SENT + 300) =>
  JSON.stringify({ type: 'user', timestamp: iso(at), message: { content: [{ type: 'tool_result', content: `grep: msg_id:${id}]` }] } })
const unrelated = (at = SENT + 300) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(at), message: { content: [{ type: 'text', text: 'working' }] } })

let root: string
let dir: string
let isolatedDir: string
let isolatedCfg: string | undefined

function writeTranscript(name: string, lines: string[], mtimeMs = SENT + 1000) {
  const p = join(dir, name)
  writeFileSync(p, lines.join('\n') + '\n')
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}

function writeIn(d: string, name: string, lines: string[], mtimeMs = SENT + 1000) {
  mkdirSync(d, { recursive: true })
  const p = join(d, name)
  writeFileSync(p, lines.join('\n') + '\n')
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
}

function deps(over: Partial<TurnCheckDeps> = {}): TurnCheckDeps & { notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn()
  return {
    transcriptDir: () => dir,
    readEvidence: readTurnEvidence,
    notify,
    now: () => SENT + 60_000,
    ...over,
  } as TurnCheckDeps & { notify: ReturnType<typeof vi.fn> }
}

const req = (ids: number[], toAgent = 'dex', host: string | null = null) => ({ toAgent, msgIds: ids, sentAtMs: SENT, host })

beforeEach(() => {
  resetTurnCheckState()
  mockCreateAgentMessage.mockClear()
  mockDebug.mockClear()
  root = mkdtempSync(join(tmpdir(), 'turncheck-'))
  dir = join(root, 'projects', '-agents-dex')
  mkdirSync(dir, { recursive: true })
  isolatedDir = join(root, 'isolated', 'projects', '-agents-dex')
  isolatedCfg = undefined
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
  delete process.env.DELIVERY_TURN_CHECK_GRACE_SEC
})

describe('classifyTranscriptLines', () => {
  it('a typed user prompt carrying the envelope tag is seen', () => {
    expect(classifyTranscriptLines([unrelated(), userPrompt(41)], 41, SENT)).toBe('seen')
  })
  it('a prompt typed into a busy pane and handed to the model (queued_command) is seen', () => {
    expect(classifyTranscriptLines(queued(42).split('\n'), 42, SENT)).toBe('seen')
    expect(classifyTranscriptLines([attachmentOnly(42)], 42, SENT)).toBe('seen')
  })
  it('a bare queue enqueue is NOT evidence (removed unprocessed would read as arrived)', () => {
    const enqueueOnly = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(SENT + 300), content: envelope(47) })
    const removed = JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: iso(SENT + 900), content: envelope(47) })
    expect(classifyTranscriptLines([enqueueOnly, removed], 47, SENT)).toBe('absent')
  })
  it('a prompt blocked by a UserPromptSubmit hook is blocked-by-hook, not seen', () => {
    expect(classifyTranscriptLines([blocked(43)], 43, SENT)).toBe('blocked-by-hook')
  })
  it('seen wins over an earlier block (the prompt went through on a later try)', () => {
    expect(classifyTranscriptLines([blocked(44), userPrompt(44, SENT + 2000)], 44, SENT)).toBe('seen')
  })
  it('nothing for the id is absent; a tool result that merely mentions the tag does not count', () => {
    expect(classifyTranscriptLines([unrelated(), toolResultMentioning(45)], 45, SENT)).toBe('absent')
  })
  it('msg_id:12 does not match msg_id:123 (the tag is anchored)', () => {
    expect(classifyTranscriptLines([userPrompt(123)], 12, SENT)).toBe('absent')
  })
  it('a row stamped well before the send is another message, not evidence', () => {
    expect(classifyTranscriptLines([userPrompt(46, SENT - 60_000)], 46, SENT)).toBe('absent')
    // ...but the measured small negative skew is tolerated.
    expect(classifyTranscriptLines([userPrompt(46, SENT - 1200)], 46, SENT)).toBe('seen')
  })
})

describe('runDeliveryTurnCheck (behaviour, real files)', () => {
  it('evidence present -> silence', async () => {
    writeTranscript('a.jsonl', [unrelated(), userPrompt(101)])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([101]), 60, 30 * 60_000, d)).toBe('confirmed')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('a batch where every id is present (prompt + queued) -> silence', async () => {
    writeTranscript('a.jsonl', [userPrompt(102), queued(103)])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([102, 103]), 60, 30 * 60_000, d)).toBe('confirmed')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('no evidence -> one alert naming id, recipient and reason, never the content', async () => {
    writeTranscript('a.jsonl', [unrelated()])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([104]), 60, 30 * 60_000, d)).toBe('alerted')
    expect(d.notify).toHaveBeenCalledTimes(1)
    const text = String(d.notify.mock.calls[0][0])
    expect(text).toContain('msg_id 104')
    expect(text).toContain("'dex'")
    expect(text).toContain('no trace')
    expect(text).not.toContain('SECRET-BODY')
  })

  it('no transcript written since the send (keys swallowed entirely) -> alert', async () => {
    writeTranscript('old.jsonl', [userPrompt(105, SENT - 3_600_000)], SENT - 3_600_000)
    const d = deps()
    expect(await runDeliveryTurnCheck(req([105]), 60, 30 * 60_000, d)).toBe('alerted')
  })

  it('blocked by hook -> alert with that reason', async () => {
    writeTranscript('a.jsonl', [blocked(106)])
    const d = deps()
    expect(await runDeliveryTurnCheck(req([106]), 60, 30 * 60_000, d)).toBe('alerted')
    const text = String(d.notify.mock.calls[0][0])
    expect(text).toContain('msg_id 106 (blocked by a UserPromptSubmit hook)')
    expect(text).not.toContain('SECRET-BODY')
  })

  it('only the missing ids of a batch are named', async () => {
    writeTranscript('a.jsonl', [userPrompt(107)])
    const d = deps()
    await runDeliveryTurnCheck(req([107, 108]), 60, 30 * 60_000, d)
    const text = String(d.notify.mock.calls[0][0])
    expect(text).toContain('msg_id 108')
    expect(text).not.toContain('msg_id 107')
  })

  it('unreadable transcript -> silence (missing dir, empty dir, remote host)', async () => {
    const d1 = deps({ transcriptDir: () => join(root, 'does-not-exist') })
    expect(await runDeliveryTurnCheck(req([109]), 60, 30 * 60_000, d1)).toBe('unknown')
    expect(d1.notify).not.toHaveBeenCalled()

    const d2 = deps() // dir exists, no .jsonl in it
    expect(await runDeliveryTurnCheck(req([110]), 60, 30 * 60_000, d2)).toBe('unknown')
    expect(d2.notify).not.toHaveBeenCalled()

    writeTranscript('a.jsonl', [unrelated()])
    const d3 = deps()
    expect(await runDeliveryTurnCheck(req([111], 'dex', 'laptop.local'), 60, 30 * 60_000, d3)).toBe('unknown')
    expect(d3.notify).not.toHaveBeenCalled()
  })

  it('a transcript that cannot be read (permission) -> silence', async () => {
    writeTranscript('a.jsonl', [unrelated()])
    const d = deps({ readEvidence: async () => null })
    expect(await runDeliveryTurnCheck(req([112]), 60, 30 * 60_000, d)).toBe('unknown')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('rate limit: one alert per recipient per window, other recipients unaffected', async () => {
    writeTranscript('a.jsonl', [unrelated()])
    let now = SENT + 60_000
    const d = deps({ now: () => now })
    expect(await runDeliveryTurnCheck(req([113]), 60, 30 * 60_000, d)).toBe('alerted')
    now += 10 * 60_000
    expect(await runDeliveryTurnCheck(req([114]), 60, 30 * 60_000, d)).toBe('suppressed')
    expect(await runDeliveryTurnCheck(req([115], 'kio'), 60, 30 * 60_000, d)).toBe('alerted')
    now += 21 * 60_000
    expect(await runDeliveryTurnCheck(req([116]), 60, 30 * 60_000, d)).toBe('alerted')
    expect(d.notify).toHaveBeenCalledTimes(3)
  })
})

describe('scheduleDeliveryTurnCheck', () => {
  it('returns at once and runs the check only after the grace period, alerting via the main agent queue', async () => {
    writeTranscript('a.jsonl', [unrelated(Date.now() + 100)], Date.now() + 100)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    process.env.DELIVERY_TURN_CHECK_GRACE_SEC = '60'
    const ret = scheduleDeliveryTurnCheck({ toAgent: 'dex', msgIds: [201], sentAtMs: Date.now(), host: null })
    expect(ret).toBeUndefined()
    await vi.advanceTimersByTimeAsync(59_000)
    await settle(() => false, 100)
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle(() => mockCreateAgentMessage.mock.calls.length > 0)
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    const [from, to, text] = mockCreateAgentMessage.mock.calls[0] as [string, string, string]
    expect(from).toBe('system')
    expect(to).toBe('orin')
    expect(text).toContain('msg_id 201')
  })

  it('a scheduled check on an unreadable transcript stays silent end to end', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    rmSync(dir, { recursive: true, force: true })
    scheduleDeliveryTurnCheck({ toAgent: 'dex', msgIds: [202], sentAtMs: Date.now(), host: null })
    await vi.advanceTimersByTimeAsync(61_000)
    // Wait for the check to FINISH (its unknown-path debug line), so a pass
    // here means "ran and stayed silent", not "had not run yet".
    await settle(debugSaid('transcript not readable'))
    expect(mockDebug.mock.calls.some((c) => String(c[1] ?? '').includes('transcript not readable'))).toBe(true)
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
  })

  it('does nothing for the main agent, for an empty id list, or with grace 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const spy = vi.spyOn(globalThis, 'setTimeout')
    scheduleDeliveryTurnCheck({ toAgent: 'orin', msgIds: [1], sentAtMs: 0, host: null })
    scheduleDeliveryTurnCheck({ toAgent: 'dex', msgIds: [], sentAtMs: 0, host: null })
    process.env.DELIVERY_TURN_CHECK_GRACE_SEC = '0'
    scheduleDeliveryTurnCheck({ toAgent: 'dex', msgIds: [1], sentAtMs: 0, host: null })
    expect(spy).not.toHaveBeenCalled()
    process.env.DELIVERY_TURN_CHECK_GRACE_SEC = '60'
    scheduleDeliveryTurnCheck({ toAgent: 'dex', msgIds: [1], sentAtMs: 0, host: null })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][1]).toBe(60_000)
    spy.mockRestore()
  })
})

describe('settings', () => {
  it('grace defaults to 60s, 0 is off, garbage falls back', () => {
    expect(graceSecFrom(undefined)).toBe(60)
    expect(graceSecFrom('')).toBe(60)
    expect(graceSecFrom('0')).toBe(0)
    expect(graceSecFrom('90')).toBe(90)
    expect(graceSecFrom('abc')).toBe(60)
    expect(graceSecFrom('-5')).toBe(60)
  })
  it('alert window defaults to 30 min', () => {
    expect(alertWindowMsFrom(undefined)).toBe(30 * 60_000)
    expect(alertWindowMsFrom('5')).toBe(5 * 60_000)
    expect(alertWindowMsFrom('0')).toBe(30 * 60_000)
  })
  it('the alert text has no em dash', () => {
    expect(formatUnconfirmedAlert('dex', 60, [{ id: 1, evidence: 'absent' }])).not.toMatch(/[\u2013\u2014]/)
  })
})

// A custom-provider agent runs WITHOUT CLAUDE_CONFIG_DIR: its transcript is in
// the shared root, while a leftover isolated projects/ (earlier Claude period)
// still exists and holds only old files.
describe('two candidate transcript roots (isolated + shared)', () => {
  const STALE = SENT - 3_600_000
  const staleIsolated = () => writeIn(isolatedDir, 'old.jsonl', [userPrompt(999, STALE)], STALE)

  it('stale isolated root + fresh shared root carrying the tag -> seen', async () => {
    staleIsolated()
    writeTranscript('live.jsonl', [unrelated(), userPrompt(301)])
    const m = await readTurnEvidence([isolatedDir, dir], [301], SENT)
    expect(m?.get(301)).toBe('seen')
  })

  it('the order of the candidates does not matter', async () => {
    staleIsolated()
    writeTranscript('live.jsonl', [userPrompt(302)])
    const m = await readTurnEvidence([dir, isolatedDir], [302], SENT)
    expect(m?.get(302)).toBe('seen')
  })

  it('tag absent in both roots -> absent, and the run still alerts', async () => {
    staleIsolated()
    writeTranscript('live.jsonl', [unrelated()])
    expect((await readTurnEvidence([isolatedDir, dir], [303], SENT))?.get(303)).toBe('absent')
    const d = deps({ transcriptDir: () => [isolatedDir, dir] })
    expect(await runDeliveryTurnCheck(req([303]), 60, 30 * 60_000, d)).toBe('alerted')
    expect(d.notify).toHaveBeenCalledTimes(1)
  })

  it('only the isolated root is fresh (Claude OAuth agent) -> seen, shared root may be missing', async () => {
    writeIn(isolatedDir, 'live.jsonl', [userPrompt(304)])
    rmSync(dir, { recursive: true, force: true })
    const m = await readTurnEvidence([isolatedDir, dir], [304], SENT)
    expect(m?.get(304)).toBe('seen')
  })

  it('a queued_command attachment in the shared root is still recognized', async () => {
    staleIsolated()
    writeTranscript('live.jsonl', [attachmentOnly(305)])
    expect((await readTurnEvidence([isolatedDir, dir], [305], SENT))?.get(305)).toBe('seen')
  })

  it('a duplicate candidate is read once and a single string still works', async () => {
    writeTranscript('live.jsonl', [userPrompt(306)])
    expect((await readTurnEvidence([dir, dir], [306], SENT))?.get(306)).toBe('seen')
    expect((await readTurnEvidence(dir, [306], SENT))?.get(306)).toBe('seen')
  })

  it('neither root holds a transcript (missing / empty) -> unknown, not absent', async () => {
    mkdirSync(isolatedDir, { recursive: true }) // exists, empty; shared dir exists, empty
    expect(await readTurnEvidence([isolatedDir, dir], [307], SENT)).toBeNull()
    rmSync(dir, { recursive: true, force: true })
    expect(await readTurnEvidence([isolatedDir, dir], [307], SENT)).toBeNull()
  })

  it('default resolver: isolated config root present but stale, live prompt in the shared root -> confirmed, no alert', async () => {
    isolatedCfg = join(root, 'isolated')
    staleIsolated()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const now = Date.now()
    writeTranscript('live.jsonl', [userPrompt(308, now + 100)], now + 100)
    process.env.DELIVERY_TURN_CHECK_GRACE_SEC = '60'
    scheduleDeliveryTurnCheck({ toAgent: 'dex', msgIds: [308], sentAtMs: now, host: null })
    await vi.advanceTimersByTimeAsync(61_000)
    await settle(debugSaid('prompt seen in transcript'))
    expect(debugSaid('prompt seen in transcript')()).toBe(true)
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
  })

  it('default resolver: tag missing from both roots -> alert', async () => {
    isolatedCfg = join(root, 'isolated')
    staleIsolated()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const now = Date.now()
    writeTranscript('live.jsonl', [unrelated(now + 100)], now + 100)
    process.env.DELIVERY_TURN_CHECK_GRACE_SEC = '60'
    scheduleDeliveryTurnCheck({ toAgent: 'dex', msgIds: [309], sentAtMs: now, host: null })
    await vi.advanceTimersByTimeAsync(61_000)
    await settle(() => mockCreateAgentMessage.mock.calls.length > 0)
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
  })
})
