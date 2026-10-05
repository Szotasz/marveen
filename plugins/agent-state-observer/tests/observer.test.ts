import { test, expect } from 'claude-code/testing'

// The engine stand-ins: every op the mod calls is answered here, beneath it,
// so nothing touches the disk, a session or a timer.
const DIR = '/install/store/mod-state'

type Opts = {
  env?: Record<string, string | undefined>
  disabled?: string[]
  rateLimits?: unknown[]
  /** The engine's own answers, to prove they come back unchanged. */
  results?: Record<string, unknown>
  /** Every fs.write throws. */
  failWrite?: boolean
}

function engine(on: any, opts: Opts = {}) {
  const env = opts.env ?? { MARVEEN_AGENT_ID: 'alpha', MARVEEN_STATE_OBSERVER_DIR: DIR }
  const writes: { path: string; text: string }[] = []
  on('env.get', ($: any, e: { name: string }) => ({ value: env[e.name] }))
  on('fs.exists', ($: any, e: { path: string }) => ({ value: (opts.disabled ?? []).some(n => e.path === `${DIR}/${n}`) }))
  on('fs.write', ($: any, e: { path: string; text: string }) => {
    if (opts.failWrite) throw new Error('disk full')
    writes.push(e)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { window: 200000, percent: 12 },
    rateLimits: opts.rateLimits ?? [{ kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-04T23:00:00Z' }],
    cost: { usd: 1.5 },
  } }))
  on('clock.every', () => new Promise(() => {}))
  const r = opts.results ?? {}
  on('session.start', ($: any, e: { cwd: string }) => r['session.start'] ?? ({ cwd: e.cwd }))
  on('turn.start', ($: any, e: { turnId: string }) => r['turn.start'] ?? ({ turnId: e.turnId }))
  on('tool.check', () => ({ decision: 'ask', reason: 'gate', hook: 'PreToolUse' }))
  on('turn.complete', () => r['turn.complete'] ?? ({ text: '' }))
  on('session.measure', () => r['session.measure'] ?? ({ changed: [] }))
  on('session.end', () => r['session.end'] ?? ({ sessionId: 'sess-1' }))
  return writes
}

// The mod's writes are chained promises it does not await: let them drain.
const settle = async () => {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}

const last = (writes: { text: string }[]) => JSON.parse(writes[writes.length - 1]!.text)

const start = ($: any) => $.session.start({ cwd: '/anywhere', surface: null, isInteractive: true })
const turn = async ($: any, id = 't1') => {
  await $.turn.start({ text: 'hi', turnId: id })
}
const done = ($: any, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...extra })

test('records the main loop state transitions and passes every result through unchanged', async ($: any, on: any) => {
  const writes = engine(on)

  await start($)
  await turn($)
  // A query (no tool_use_id) is not a real call: no awaiting_approval.
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  await settle()
  expect(last(writes).state).toBe('working')
  const checked = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' })
  expect(checked).toEqual({ decision: 'ask', reason: 'gate', hook: 'PreToolUse' })
  await done($)
  await settle()

  const s = last(writes)
  expect(writes.every(w => w.path === `${DIR}/alpha.json`)).toBe(true)
  expect(s.agent).toBe('alpha')
  expect(s.state).toBe('idle')
  expect(s.session_id).toBe('sess-1')
  expect(s.history.map((h: { to: string }) => h.to)).toEqual(['idle', 'working', 'awaiting_approval', 'idle'])
  expect(s.history[2].tool).toBe('Bash')
  expect(s.usage.rateLimits).toEqual([{ kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-04T23:00:00Z' }])
  expect(s.first_usage_probe.rateLimits_empty).toBe(false)
})

test('a subagent turn ending does not mark the agent idle', async ($: any, on: any) => {
  const writes = engine(on)
  await start($)
  await turn($)
  await done($, { turnId: 't9', agentId: 'sub-1' })
  await settle()
  expect(last(writes).state).toBe('working')
})

test('an empty rateLimits reading is recorded as empty, not skipped', async ($: any, on: any) => {
  const writes = engine(on, { rateLimits: [] })
  await start($)
  await turn($)
  await done($)
  await settle()
  const s = last(writes)
  expect(s.first_usage_probe.rateLimits_empty).toBe(true)
  expect(s.usage.rateLimits).toEqual([])
})

test('without the agent name from the launcher nothing is written', async ($: any, on: any) => {
  const writes = engine(on, { env: { MARVEEN_STATE_OBSERVER_DIR: DIR } })
  await start($)
  await turn($)
  await done($)
  await settle()
  expect(writes.length).toBe(0)
})

test('without the output folder from the launcher nothing is written', async ($: any, on: any) => {
  const writes = engine(on, { env: { MARVEEN_AGENT_ID: 'alpha' } })
  await start($)
  await turn($)
  await settle()
  expect(writes.length).toBe(0)
})

test('a malformed agent name writes nothing (no path escape)', async ($: any, on: any) => {
  const writes = engine(on, { env: { MARVEEN_AGENT_ID: '../etc', MARVEEN_STATE_OBSERVER_DIR: DIR } })
  await start($)
  await turn($)
  await settle()
  expect(writes.length).toBe(0)
})

test('a trailing slash on the folder is not doubled', async ($: any, on: any) => {
  const writes = engine(on, { env: { MARVEEN_AGENT_ID: 'alpha', MARVEEN_STATE_OBSERVER_DIR: `${DIR}/` } })
  await start($)
  await settle()
  expect(writes[0]!.path).toBe(`${DIR}/alpha.json`)
})

test('the global DISABLE stops writes and results still pass through', async ($: any, on: any) => {
  const writes = engine(on, { disabled: ['DISABLE'] })
  await start($)
  await turn($)
  const checked = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' })
  await done($)
  await settle()
  expect(checked.decision).toBe('ask')
  expect(writes.length).toBe(0)
})

test('a per-agent DISABLE stops that agent only', async ($: any, on: any) => {
  const other = engine(on, { disabled: ['DISABLE-beta'] })
  await start($)
  await turn($)
  await settle()
  expect(other.length > 0).toBe(true)
})

test('the per-agent DISABLE of this agent stops its writes', async ($: any, on: any) => {
  const writes = engine(on, { disabled: ['DISABLE-alpha'] })
  await start($)
  await turn($)
  await settle()
  expect(writes.length).toBe(0)
})

// Geri's #1692 review gaps (a) and (b): the observe-only promise held for EVERY
// hook, and a failing write never reaching the agent.

test('every hook hands back the engine result unchanged', async ($: any, on: any) => {
  engine(on, { results: {
    'session.start': { cwd: '/engine-cwd' },
    'turn.start': { turnId: 'engine-turn' },
    'turn.complete': { text: 'engine-answer' },
    'session.measure': { changed: ['context'] },
    'session.end': { sessionId: 'engine-session' },
  } })

  expect(await start($)).toEqual({ cwd: '/engine-cwd' })
  expect(await $.turn.start({ text: 'hi', turnId: 't1' })).toEqual({ turnId: 'engine-turn' })
  expect(await done($)).toEqual({ text: 'engine-answer' })
  expect(await $.session.measure({ context: { window: 1 }, rateLimits: [], changed: ['context'] })).toEqual({ changed: ['context'] })
  expect(await $.session.end({ reason: 'other' })).toEqual({ sessionId: 'engine-session' })
})

test('a write that fails is swallowed: the turn goes on and results are unchanged', async ($: any, on: any) => {
  engine(on, { failWrite: true })

  await start($)
  await turn($)
  const checked = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' })
  const answer = await done($)
  await settle()
  expect(checked).toEqual({ decision: 'ask', reason: 'gate', hook: 'PreToolUse' })
  expect(answer).toEqual({ text: '' })
})
