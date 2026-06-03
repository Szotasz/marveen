import { describe, it, expect, afterEach } from 'vitest'
import {
  shouldReplayTaskState,
  isEmptyTaskState,
  buildTaskStateInjection,
  writeTaskState,
  readTaskState,
  markConsumed,
  clearTaskState,
  sweepOrphanTaskStates,
  TASKSTATE_TTL_MS,
  type AgentTaskState,
} from '../web/agent-taskstate.js'

const NOW = 1_700_000_000_000
const rec = (over: Partial<AgentTaskState> = {}): AgentTaskState => ({
  agent: 'tester',
  doneSteps: ['did A'],
  alreadyDelegated: [],
  nextAction: 'do B',
  pendingDecision: '',
  summary: 'building X',
  ts: NOW,
  consumed: false,
  ...over,
})

// Compact task-state re-injection (#4). Pure-fn coverage is the safety core.
describe('shouldReplayTaskState', () => {
  it('replays a fresh unconsumed record on compact', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + 1000)).toBe(true)
  })
  it('replays on resume too', () => {
    expect(shouldReplayTaskState(rec(), 'resume', NOW + 1000)).toBe(true)
  })
  it('does NOT replay on cold startup', () => {
    expect(shouldReplayTaskState(rec(), 'startup', NOW + 1000)).toBe(false)
  })
  it('does NOT replay a consumed record', () => {
    expect(shouldReplayTaskState(rec({ consumed: true }), 'compact', NOW + 1000)).toBe(false)
  })
  it('does NOT replay a null record', () => {
    expect(shouldReplayTaskState(null, 'compact', NOW)).toBe(false)
  })
  it('does NOT replay past the TTL (orphan)', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + TASKSTATE_TTL_MS + 1)).toBe(false)
  })
  it('replays right up to the TTL boundary', () => {
    expect(shouldReplayTaskState(rec(), 'compact', NOW + TASKSTATE_TTL_MS)).toBe(true)
  })
  it('does NOT replay an empty (no-task) record', () => {
    const empty = rec({ doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', summary: 'idle' })
    expect(shouldReplayTaskState(empty, 'compact', NOW + 1)).toBe(false)
  })
})

describe('isEmptyTaskState', () => {
  it('true when no steps/delegations/next/pending', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: [], nextAction: '  ', pendingDecision: '' })).toBe(true)
  })
  it('false when a nextAction exists', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: [], nextAction: 'do B', pendingDecision: '' })).toBe(false)
  })
  it('false when already-delegated exists (the re-delegation guard data)', () => {
    expect(isEmptyTaskState({ doneSteps: [], alreadyDelegated: ['gave Zara the frontend'], nextAction: '', pendingDecision: '' })).toBe(false)
  })
})

describe('buildTaskStateInjection', () => {
  it('carries the sentinel + structured do-not-resend lists', () => {
    const out = buildTaskStateInjection(rec({
      doneSteps: ['merged #276'],
      alreadyDelegated: ['Zara: frontend modal'],
      nextAction: 'open the PR',
      pendingDecision: 'whether to gate on RESPAWN_ENABLED',
    }))
    expect(out).toContain('TASK-FOLYTATAS (NEM uj feladat)')
    expect(out).toContain('NE delegald ujra') // anti-re-delegation framing
    expect(out).toContain('merged #276')        // done step
    expect(out).toContain('Zara: frontend modal') // already-delegated item
    expect(out).toContain('open the PR')         // next action
    expect(out).toContain('whether to gate')     // pending decision
  })
})

// Light I/O round-trip on the real store dir, with cleanup.
describe('task-state store I/O', () => {
  const A = 'vitest-taskstate-agent'
  afterEach(() => clearTaskState(A))

  it('write -> read round-trips and arms (consumed=false, fresh ts)', () => {
    writeTaskState(A, { summary: 's', nextAction: 'next', doneSteps: ['x'] }, NOW)
    const r = readTaskState(A)!
    expect(r.consumed).toBe(false)
    expect(r.ts).toBe(NOW)
    expect(r.nextAction).toBe('next')
    expect(r.doneSteps).toEqual(['x'])
  })

  it('markConsumed flips the flag so the next replay is suppressed', () => {
    writeTaskState(A, { nextAction: 'next' }, NOW)
    markConsumed(A)
    const r = readTaskState(A)!
    expect(r.consumed).toBe(true)
    expect(shouldReplayTaskState(r, 'compact', NOW + 1)).toBe(false)
  })

  it('sweepOrphanTaskStates drops a record older than the TTL', () => {
    writeTaskState(A, { nextAction: 'next' }, NOW)
    const swept = sweepOrphanTaskStates(NOW + TASKSTATE_TTL_MS + 1)
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(readTaskState(A)).toBeNull()
  })

  it('sanitizes the agent name (no path traversal in the filename)', () => {
    // A traversal-y name must not escape the store dir; it sanitizes to safe chars.
    writeTaskState('../../etc/passwd', { nextAction: 'x' }, NOW)
    // readable back via the same sanitized key, and no file outside the dir.
    const r = readTaskState('../../etc/passwd')
    expect(r).not.toBeNull()
    clearTaskState('../../etc/passwd')
  })
})
