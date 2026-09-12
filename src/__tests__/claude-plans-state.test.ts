// PR2b: readClaudePlansState(), the reader for store/claude-plans-state.json.
// PR2c: writeClaudePlansState() + the pure recordObservation()/applyRotation()
// transitions, finalizing the schema per design decision #1 (2026-09-12):
// activePlanId -> activePlanByAgent, keyed by agent id.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-state-test-'))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot }))

const {
  readClaudePlansState,
  writeClaudePlansState,
  recordObservation,
  applyRotation,
  CLAUDE_PLANS_STATE_PATH,
} = await import('../web/claude-plans-state.js')

describe('readClaudePlansState', () => {
  it('returns an empty state when the file does not exist', () => {
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('returns an empty state on unparseable JSON', () => {
    mkdirSync(join(tmpRoot, 'store'), { recursive: true })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, 'not json')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('returns an empty state when the JSON is not an object (array, null, primitive)', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, '[]')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, 'null')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, '"pro"')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('reads a well-formed snapshot back verbatim', () => {
    const snapshot = {
      activePlanByAgent: { marveen: 'pro', devy: 'team' },
      plans: {
        pro: { observedAt: 1_700_000_000_000, source: 'authoritative', windows: { five_hour: { usedPercent: 42, resetsAt: 1_700_010_000 } } },
        team: { observedAt: 1_699_000_000_000, source: 'authoritative_cached', windows: {} },
      },
    }
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify(snapshot))
    expect(readClaudePlansState()).toEqual(snapshot)
  })

  it('defaults a missing/bad-typed activePlanByAgent or plans key rather than throwing', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: 42, plans: 'nope' }))
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })

    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({}))
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('drops activePlanByAgent when any value is not a string', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: { marveen: 42 }, plans: {} }))
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })
})

describe('writeClaudePlansState', () => {
  it('creates store/ and writes the file atomically (readable back)', () => {
    const state = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    writeClaudePlansState(state)
    expect(JSON.parse(readFileSync(CLAUDE_PLANS_STATE_PATH, 'utf8'))).toEqual(state)
    expect(readClaudePlansState()).toEqual(state)
  })

  it('leaves no .tmp file behind after a successful write', () => {
    writeClaudePlansState({ activePlanByAgent: {}, plans: {} })
    const leftovers = readdirSync(join(tmpRoot, 'store')).filter((f: string) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('recordObservation', () => {
  it('sets the agent active on the plan and records its window snapshot', () => {
    const before = { activePlanByAgent: {}, plans: {} }
    const observed = { observedAt: 123, source: 'authoritative', windows: { five_hour: { usedPercent: 10, resetsAt: 456 } } }
    const after = recordObservation(before, 'marveen', 'pro', observed)
    expect(after).toEqual({ activePlanByAgent: { marveen: 'pro' }, plans: { pro: observed } })
  })

  it('does not mutate the input state (pure)', () => {
    const before = { activePlanByAgent: { marveen: 'pro' }, plans: { pro: { observedAt: 1, source: 'x', windows: {} } } }
    const snapshot = JSON.parse(JSON.stringify(before))
    recordObservation(before, 'marveen', 'pro', { observedAt: 2, source: 'y', windows: {} })
    expect(before).toEqual(snapshot)
  })

  it('leaves other agents and other plans untouched', () => {
    const before = {
      activePlanByAgent: { marveen: 'pro', devy: 'team' },
      plans: { team: { observedAt: 1, source: 'authoritative', windows: {} } },
    }
    const after = recordObservation(before, 'marveen', 'pro', { observedAt: 2, source: 'authoritative', windows: {} })
    expect(after.activePlanByAgent.devy).toBe('team')
    expect(after.plans.team).toEqual(before.plans.team)
  })
})

describe('applyRotation', () => {
  it('points the agent at the target plan, leaving plans untouched', () => {
    const before = { activePlanByAgent: { marveen: 'pro' }, plans: { pro: { observedAt: 1, source: 'x', windows: {} } } }
    const after = applyRotation(before, 'marveen', 'team')
    expect(after.activePlanByAgent).toEqual({ marveen: 'team' })
    expect(after.plans).toEqual(before.plans)
  })

  it('adds a fresh entry for an agent with no prior active plan (the bootstrap case)', () => {
    const before = { activePlanByAgent: {}, plans: {} }
    const after = applyRotation(before, 'marveen', 'pro')
    expect(after.activePlanByAgent).toEqual({ marveen: 'pro' })
  })

  it('does not mutate the input state (pure)', () => {
    const before = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    const snapshot = JSON.parse(JSON.stringify(before))
    applyRotation(before, 'marveen', 'team')
    expect(before).toEqual(snapshot)
  })
})
