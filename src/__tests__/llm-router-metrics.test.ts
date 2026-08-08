import { describe, it, expect } from 'vitest'
import {
  servedMetric,
  refusedMetric,
  summarise,
  toJsonl,
  parseJsonl,
  nsToMs,
  type RouteMetric,
} from '../llm-router/metrics.js'

// What the router did, in numbers -- and, as importantly, what the numbers do
// NOT carry.
//
// The scheduled work that will use this router handles mail, kanban cards and
// private notes. A metrics file is the sort of artefact that gets copied into
// a report or a chat without anyone re-reading what is in it, so the absence
// of payload is a property worth asserting rather than a habit worth trusting.

const served = (over: Partial<Parameters<typeof servedMetric>[0]> = {}) =>
  servedMetric({
    at: 1_000,
    taskClass: 'summary',
    host: 'air903max',
    model: 'qwen3-coder:latest',
    totalMs: 1200,
    ollama: { prompt_eval_count: 100, eval_count: 40, load_duration: 0, eval_duration: 900_000_000 },
    ...over,
  })

describe('what a served request records', () => {
  it('names the class, the machine and the model that answered', () => {
    expect(served()).toMatchObject({ taskClass: 'summary', host: 'air903max', model: 'qwen3-coder:latest' })
  })

  it('separates model loading from generating', () => {
    // The difference between "the local path is slow" and "the local path is
    // slow when it swaps models" -- only the second has an obvious fix.
    const m = served({ ollama: { load_duration: 17_000_000_000, eval_duration: 3_000_000_000 } })
    expect(m.loadMs).toBe(17_000)
    expect(m.evalMs).toBe(3_000)
  })

  it('leaves counts null when the machine did not report them', () => {
    // A zero would read as "no tokens", which is a measurement nobody took.
    const m = served({ ollama: {} })
    expect(m.promptTokens).toBeNull()
    expect(m.evalTokens).toBeNull()
    expect(m.loadMs).toBeNull()
  })

  it('survives a machine that reports nothing at all', () => {
    expect(() => served({ ollama: null })).not.toThrow()
  })
})

describe('what the record does not contain', () => {
  it('has no field that could hold the prompt or the answer', () => {
    const keys = Object.keys(served()).map((k) => k.toLowerCase())
    // promptTokens is a COUNT and stays -- it is what answers the cost
    // question. What must not exist is a field that could carry the text.
    for (const forbidden of ['messages', 'content', 'answer', 'hash', 'body']) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false)
    }
  })

  it('holds no free text at all, whatever the field is called', () => {
    // The property that actually matters, asserted on the VALUES: every string
    // in a record is a short identifier (class, host, model, refusal code).
    // A prompt or an answer smuggled into any field would fail this.
    const record = served({ taskClass: 'hungarian', model: 'gemma4:31b-magyar' })
    for (const value of Object.values(record)) {
      if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(64)
      else expect(value === null || typeof value === 'number').toBe(true)
    }
  })

  it('carries no price', () => {
    // The canonical place for cost is decided in #168. A number here as well
    // would put the same fact in two places, and one of them would drift.
    const keys = Object.keys(served()).map((k) => k.toLowerCase())
    for (const forbidden of ['cost', 'price', 'usd', 'huf']) {
      expect(keys.some((k) => k.includes(forbidden))).toBe(false)
    }
  })
})

describe('what a refusal records', () => {
  it('keeps the reason and the status, with no machine attached', () => {
    const m = refusedMetric({ at: 1, taskClass: 'agent-loop', status: 501, refusal: 'cloud-only', totalMs: 3 })
    expect(m).toMatchObject({ refusal: 'cloud-only', status: 501, host: null, model: null })
  })

  it('still records how long the caller waited for the no', () => {
    // A refusal that takes four seconds is a different fact from one that
    // takes three milliseconds.
    expect(refusedMetric({ at: 1, taskClass: 'summary', status: 503, refusal: 'all-busy', totalMs: 4200 }).totalMs).toBe(4200)
  })
})

describe('the summary', () => {
  const records: RouteMetric[] = [
    served(),
    served({ taskClass: 'code', model: 'laguna-xs.2:fixed', totalMs: 21_000, ollama: { prompt_eval_count: 50, eval_count: 200, load_duration: 17_000_000_000 } }),
    served({ taskClass: 'hungarian', model: 'gemma4:31b-magyar', totalMs: 22_000, ollama: { load_duration: 18_000_000_000 } }),
    refusedMetric({ at: 5, taskClass: 'agent-loop', status: 501, refusal: 'cloud-only', totalMs: 2 }),
  ]
  const s = summarise(records)

  it('counts requests, served and refused separately', () => {
    expect(s).toMatchObject({ requests: 4, served: 3, refused: 1 })
  })

  it('breaks down by class, host, model and refusal reason', () => {
    expect(s.byClass).toMatchObject({ summary: 1, code: 1, hungarian: 1, 'agent-loop': 1 })
    expect(s.byHost).toMatchObject({ air903max: 3 })
    expect(s.byModel).toMatchObject({ 'laguna-xs.2:fixed': 1 })
    expect(s.byRefusal).toMatchObject({ 'cloud-only': 1 })
  })

  it('does not attribute a machine to a request that never reached one', () => {
    expect(Object.values(s.byHost).reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('adds up the tokens it was given, ignoring the ones it was not', () => {
    expect(s.tokens).toMatchObject({ prompt: 150, eval: 240 })
  })

  it('bills model loading separately, counting only the requests that paid it', () => {
    // Averaging over every request would hide the thrash behind the calls that
    // reused a warm model -- which is the comparison this exists to make.
    expect(s.loadMs).toMatchObject({ total: 35_000, requestsWithLoad: 2 })
  })

  it('reports a median and a worst case rather than a mean', () => {
    expect(s.latencyMs.max).toBe(22_000)
    expect(s.latencyMs.p50).toBe(1200)
  })

  it('says nothing rather than zero when there is nothing to report', () => {
    expect(summarise([]).latencyMs).toMatchObject({ p50: null, max: null })
  })
})

describe('the file format', () => {
  it('round-trips a record', () => {
    const m = served()
    expect(parseJsonl(toJsonl(m))).toEqual([m])
  })

  it('skips a truncated last line instead of reporting nothing', () => {
    // A crash mid-append must not hide the thousand good lines above it.
    const text = `${toJsonl(served())}{"at":2,"taskCl`
    expect(parseJsonl(text)).toHaveLength(1)
  })

  it('ignores blank lines', () => {
    expect(parseJsonl(`\n${toJsonl(served())}\n\n`)).toHaveLength(1)
  })
})

describe('the nanosecond conversion', () => {
  it('is null for anything that is not a number', () => {
    expect(nsToMs(undefined)).toBeNull()
    expect(nsToMs('17000')).toBeNull()
    expect(nsToMs(NaN)).toBeNull()
  })
})
