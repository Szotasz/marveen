// What the router actually did, in numbers.
//
// One record per request, so the questions the eco-mode work keeps running
// into can be answered from data rather than from impressions: which classes
// are actually used, which machine served them, how much of the latency was
// the model LOADING rather than generating (the thrash the plan warns about),
// and how often the router said no and why.
//
// Two things are deliberately absent.
//
// No payload. Not the prompt, not the answer, not a hash of either. The
// scheduled work carries mail, kanban cards and private notes, and a metrics
// file is exactly the sort of thing that gets copied around without anyone
// re-reading what is in it. Token COUNTS answer the cost question; the text
// does not need to be here to do that.
//
// And no cost figure. The canonical place for cost attribution is decided in
// #168, and writing a price here as well would put the same fact in two
// places, where one of them will eventually be wrong. This records what a
// cost calculation needs (class, host, model, tokens, timing) and leaves the
// arithmetic to whoever owns it.

export interface RouteMetric {
  /** Epoch milliseconds; the only clock the router has. */
  at: number
  taskClass: string
  /** Null when the request never reached a machine. */
  host: string | null
  model: string | null
  status: number
  /** Refusal code when the router said no, otherwise null. */
  refusal: string | null
  promptTokens: number | null
  evalTokens: number | null
  /** Wall clock the caller waited, measured by the router. */
  totalMs: number
  /**
   * How much of that was the model being loaded into VRAM.
   *
   * Separated because it is the difference between "the local path is slow"
   * and "the local path is slow when it has to swap models" -- and only the
   * second has an obvious fix.
   */
  loadMs: number | null
  /** Generation time as ollama reports it, when it reports it. */
  evalMs: number | null
}

/** Nanoseconds to milliseconds, or null -- never a zero we did not measure. */
export function nsToMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value / 1e6) : null
}

interface OllamaTimings {
  prompt_eval_count?: number
  eval_count?: number
  load_duration?: number
  eval_duration?: number
}

/**
 * Build the record for a request that was served.
 *
 * Counts that the machine did not report stay null. A zero would read as "no
 * tokens", which is a measurement nobody took.
 */
export function servedMetric(args: {
  at: number
  taskClass: string
  host: string
  model: string
  totalMs: number
  ollama: OllamaTimings | null | undefined
}): RouteMetric {
  const o = args.ollama ?? {}
  return {
    at: args.at,
    taskClass: args.taskClass,
    host: args.host,
    model: args.model,
    status: 200,
    refusal: null,
    promptTokens: typeof o.prompt_eval_count === 'number' ? o.prompt_eval_count : null,
    evalTokens: typeof o.eval_count === 'number' ? o.eval_count : null,
    totalMs: args.totalMs,
    loadMs: nsToMs(o.load_duration),
    evalMs: nsToMs(o.eval_duration),
  }
}

/** Build the record for a request the router refused or could not complete. */
export function refusedMetric(args: {
  at: number
  taskClass: string
  status: number
  refusal: string
  totalMs: number
  host?: string | null
}): RouteMetric {
  return {
    at: args.at,
    taskClass: args.taskClass,
    host: args.host ?? null,
    model: null,
    status: args.status,
    refusal: args.refusal,
    promptTokens: null,
    evalTokens: null,
    totalMs: args.totalMs,
    loadMs: null,
    evalMs: null,
  }
}

export interface MetricsSummary {
  requests: number
  served: number
  refused: number
  byClass: Record<string, number>
  byHost: Record<string, number>
  byModel: Record<string, number>
  byRefusal: Record<string, number>
  tokens: { prompt: number; eval: number }
  /** Milliseconds spent loading models -- the thrash bill, separately. */
  loadMs: { total: number; requestsWithLoad: number }
  latencyMs: { p50: number | null; max: number | null }
}

const tally = (target: Record<string, number>, key: string | null) => {
  if (key === null) return
  target[key] = (target[key] ?? 0) + 1
}

/**
 * Aggregate a set of records.
 *
 * Pure, so the acceptance check -- do these numbers match what the battery
 * counted -- is a comparison of two numbers rather than an inspection of a
 * running process.
 */
export function summarise(records: RouteMetric[]): MetricsSummary {
  const summary: MetricsSummary = {
    requests: records.length,
    served: 0,
    refused: 0,
    byClass: {},
    byHost: {},
    byModel: {},
    byRefusal: {},
    tokens: { prompt: 0, eval: 0 },
    loadMs: { total: 0, requestsWithLoad: 0 },
    latencyMs: { p50: null, max: null },
  }

  const latencies: number[] = []

  for (const r of records) {
    if (r.refusal) {
      summary.refused += 1
      tally(summary.byRefusal, r.refusal)
    } else {
      summary.served += 1
    }
    tally(summary.byClass, r.taskClass)
    tally(summary.byHost, r.host)
    tally(summary.byModel, r.model)
    summary.tokens.prompt += r.promptTokens ?? 0
    summary.tokens.eval += r.evalTokens ?? 0
    // Only requests that actually reported a load are counted, so the average
    // is not diluted by the ones that reused a warm model.
    if (r.loadMs !== null && r.loadMs > 0) {
      summary.loadMs.total += r.loadMs
      summary.loadMs.requestsWithLoad += 1
    }
    latencies.push(r.totalMs)
  }

  if (latencies.length) {
    const sorted = [...latencies].sort((a, b) => a - b)
    summary.latencyMs.p50 = sorted[Math.floor((sorted.length - 1) / 2)]
    summary.latencyMs.max = sorted[sorted.length - 1]
  }

  return summary
}

/** One JSON object per line -- appendable, greppable, and trivially parsed back. */
export function toJsonl(record: RouteMetric): string {
  return `${JSON.stringify(record)}\n`
}

/**
 * Parse a metrics file back.
 *
 * A truncated last line (a crash mid-append) is skipped rather than throwing:
 * the endpoint's job is to report what IS there, and one damaged line must not
 * hide the other thousand.
 */
export function parseJsonl(text: string): RouteMetric[] {
  const out: RouteMetric[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as RouteMetric)
    } catch {
      /* a partial line is not a reason to report nothing */
    }
  }
  return out
}
