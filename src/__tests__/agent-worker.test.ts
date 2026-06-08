import { describe, expect, it } from 'vitest'
import { buildWorkerPrompt, decidePoll } from '../web/agent-worker.js'

// Pure-logic tests for the interactive-tmux worker that backs runAgent on the
// subscription (jun.15 migration). The live-session orchestration is exercised
// by the heartbeat-path integration check; these cover the decision core.

describe('buildWorkerPrompt', () => {
  const out = '/w/scratch/abc.out'
  const done = '/w/scratch/abc.done'

  it('keeps the caller prompt verbatim and first (only content instruction)', () => {
    const caller = 'Summarize today in 5 sentences. Magyarul.'
    const p = buildWorkerPrompt(caller, out, done)
    expect(p.startsWith(caller)).toBe(true)
  })

  it('directs the answer to the .out file and a done marker to the .done file', () => {
    const p = buildWorkerPrompt('x', out, done)
    expect(p).toContain(out)
    expect(p).toContain(done)
    expect(p).toMatch(/Write tool/)
    expect(p).toMatch(/do not print the response|Do not print the response/i)
  })

  it('does not inject any persona / project voice', () => {
    const p = buildWorkerPrompt('TASK', out, done)
    expect(p).not.toMatch(/Marveen|Szabolcs|asszisztens/i)
  })
})

describe('decidePoll', () => {
  const base = { doneExists: false, sessionAlive: true, elapsedMs: 0, timeoutMs: 1000 }

  it('returns ready as soon as the done sentinel exists', () => {
    expect(decidePoll({ ...base, doneExists: true })).toBe('ready')
  })

  it('done takes priority even if the deadline passed and the session died', () => {
    // A request that completed in the same tick the session died must still
    // return its result, not be reported dead/timeout.
    expect(decidePoll({ doneExists: true, sessionAlive: false, elapsedMs: 9999, timeoutMs: 1000 })).toBe('ready')
  })

  it('times out once past the deadline (no done yet)', () => {
    expect(decidePoll({ ...base, elapsedMs: 1000 })).toBe('timeout')
    expect(decidePoll({ ...base, elapsedMs: 1500 })).toBe('timeout')
  })

  it('fails fast (dead) when the session vanishes mid-run, before the deadline', () => {
    expect(decidePoll({ ...base, sessionAlive: false, elapsedMs: 10 })).toBe('dead')
  })

  it('keeps waiting while alive, before the deadline, with no done yet', () => {
    expect(decidePoll({ ...base, elapsedMs: 500 })).toBe('wait')
  })
})
