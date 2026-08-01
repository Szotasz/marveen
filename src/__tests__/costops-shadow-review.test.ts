// Contract tests for the boundaries of a shadow review.
//
// The evaluation logic is tested in costops-shadow-eval.test.ts. What is pinned
// here is everything that decides WHAT gets evaluated -- and every case below
// comes from an actual wrong answer produced while assembling the first review
// by hand (2026-08-01). The pattern was the same each time: the measurement was
// confidently about something other than the worker.

import { describe, it, expect } from 'vitest'
import {
  pickTranscript,
  transcriptSettle,
  runWindow,
  lastRunStartMs,
  transcriptTimestamps,
  collectorState,
  priceRun,
  RUN_GAP_MS,
  SETTLE_THRESHOLD_MS,
} from '../costops/shadow-review.js'

const line = (ts: string) => JSON.stringify({ type: 'assistant', timestamp: ts })
const HOUR = 3600_000

describe('which transcript', () => {
  it('takes the most recently written one', () => {
    const pick = pickTranscript([
      { path: 'old.jsonl', mtimeMs: 1000 },
      { path: 'newest.jsonl', mtimeMs: 3000 },
      { path: 'middle.jsonl', mtimeMs: 2000 },
    ])
    expect(pick?.path).toBe('newest.jsonl')
  })

  it('returns null instead of inventing one', () => {
    expect(pickTranscript([])).toBeNull()
  })
})

describe('has the run finished', () => {
  it('is not settled while the transcript is still being written', () => {
    const s = transcriptSettle(1_000_000, 1_000_000 + 5_000)
    expect(s.settled).toBe(false)
    expect(s.settledForMs).toBe(5_000)
  })

  it('is settled once it has been quiet for the threshold', () => {
    expect(transcriptSettle(1_000_000, 1_000_000 + SETTLE_THRESHOLD_MS).settled).toBe(true)
  })

  it('reports the threshold it used, so the number documents itself', () => {
    expect(transcriptSettle(0, 1, 9_000).thresholdMs).toBe(9_000)
  })
})

describe('which window', () => {
  it('ends when the latest run began, not when the session was created', () => {
    // The real failure: the worker's tmux session had been alive since the day
    // before, so the transcript's FIRST timestamp was 22 hours before the run.
    // Measuring from there scored the worker against cards from a day it was
    // never asked about (1/12 instead of 15/21).
    const lines = [
      line('2026-07-31T07:53:50Z'),   // session created, no work
      line('2026-08-01T05:45:09Z'),   // today's run starts here
      line('2026-08-01T05:45:15Z'),
      line('2026-08-01T05:48:15Z'),
    ]
    expect(lastRunStartMs(lines)).toBe(Date.parse('2026-08-01T05:45:09Z'))
  })

  it('keeps a single continuous run whole', () => {
    const lines = [line('2026-08-01T05:45:09Z'), line('2026-08-01T05:46:00Z'), line('2026-08-01T05:48:15Z')]
    expect(lastRunStartMs(lines)).toBe(Date.parse('2026-08-01T05:45:09Z'))
  })

  it('splits on a gap longer than the run-gap threshold, not on a pause inside a run', () => {
    const start = Date.parse('2026-08-01T05:00:00Z')
    const withinRun = [line(new Date(start).toISOString()), line(new Date(start + RUN_GAP_MS - 1000).toISOString())]
    expect(lastRunStartMs(withinRun)).toBe(start)
    const acrossRuns = [line(new Date(start).toISOString()), line(new Date(start + RUN_GAP_MS + 1000).toISOString())]
    expect(lastRunStartMs(acrossRuns)).toBe(start + RUN_GAP_MS + 1000)
  })

  it('ignores lines with no usable timestamp', () => {
    expect(transcriptTimestamps(['not json', JSON.stringify({ type: 'custom-title' }), line('2026-08-01T05:45:09Z')]))
      .toEqual([Date.parse('2026-08-01T05:45:09Z')])
    expect(lastRunStartMs(['not json at all'])).toBeNull()
  })

  it('says which end it used, because that changes the question', () => {
    const runStart = Date.parse('2026-08-01T05:45:09Z')
    const fromRun = runWindow(runStart, runStart + 3 * 60_000, 10)
    expect(fromRun.endSource).toBe('run_start')
    expect(fromRun.end - fromRun.start).toBe(10 * 3600)
    // No timestamps at all: the mtime is a worse answer, and is labelled as one.
    expect(runWindow(null, runStart, 10).endSource).toBe('file_mtime')
  })
})

describe('is the cost half even available', () => {
  it('knows when the collector has caught up', () => {
    expect(collectorState(170_757, 170_757)).toBe('current')
  })

  it('flags a collector that is behind the file', () => {
    // The real case: the hourly collector had last run minutes BEFORE the task,
    // so its cursor sat at 2 008 bytes of a 170 757-byte transcript and the
    // token table held no rows for the agent at all.
    expect(collectorState(2_008, 170_757)).toBe('behind')
  })

  it('distinguishes never-seen from behind', () => {
    // Both mean "no numbers yet", but only one of them is a stalled collector.
    expect(collectorState(null, 170_757)).toBe('unseen')
  })
})

describe('what the run cost', () => {
  const row = (over: Partial<Parameters<typeof priceRun>[0][number]> = {}) => ({
    timestamp: 1_785_000_000, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, model: 'claude-sonnet-5', ...over,
  })

  it('reports the entry context from the FIRST call, whatever order the rows arrive in', () => {
    const cost = priceRun([
      row({ timestamp: 200, cache_read_tokens: 64_000 }),
      row({ timestamp: 100, cache_read_tokens: 27_561, cache_creation_tokens: 36_597 }),
    ])
    expect(cost.entry_context_tokens).toBe(27_561 + 36_597)
  })

  it('prices the same volume on another model without mixing the two', () => {
    // Sonnet $3/M in, Opus $5/M in -> the ratio is the model swap alone.
    const cost = priceRun([row({ input_tokens: 1_000_000 })], 'claude-opus-5')
    expect(cost.list_price_equivalent_usd).toBeCloseTo(3, 4)
    expect(cost.comparison?.usd).toBeCloseTo(5, 4)
    expect(cost.comparison?.ratio).toBeCloseTo(1.67, 2)
  })

  it('surfaces calls it cannot price instead of counting them as free', () => {
    const cost = priceRun([row({ model: 'some-unknown-model', input_tokens: 1_000_000 })])
    expect(cost.unpriced_calls).toBe(1)
    expect(cost.list_price_equivalent_usd).toBe(0)
  })

  it('has no entry context when there were no calls', () => {
    const cost = priceRun([])
    expect(cost.entry_context_tokens).toBeNull()
    expect(cost.calls).toBe(0)
  })
})
