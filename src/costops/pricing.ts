// CostOps v0.2 -- token -> list-price-equivalent mapping.
//
// v0.1 deliberately left token_usage unpriced, with the note "token_usage has
// no model column; token->cost mapping lands in v0.2 after model/session
// enrichment". That enrichment has since happened: `model` is now populated on
// every row (9309/9309 as of 2026-07-31, no NULLs anywhere in the table), so
// the stated precondition holds and pricing is unblocked.
//
// WHAT THIS IS NOT: money owed. The operator runs on a Claude subscription, not
// API billing, so no invoice corresponds to these numbers. Every figure this
// module produces is a LIST-PRICE EQUIVALENT -- what the same token volume
// would cost at published first-party API rates. It is a usage yardstick for
// budgeting and routing decisions, and it is labelled as such on every output.
// It must never be added to the money ledger's current_spend: the subscription
// is already counted there as a fixed cost, so summing the two double-counts.
//
// Pure arithmetic. No network, no LLM, no secrets.

/**
 * Published first-party API rates, USD per 1M tokens, as [input, output].
 *
 * Source: the `claude-api` skill's pricing table (cached 2026-06-24). Taken
 * from documentation rather than recalled, because a wrong constant here is
 * invisible -- it produces a plausible number that is silently wrong.
 *
 * Bump PRICE_MAP_VERSION on any edit so a stored figure can be traced back to
 * the rates that produced it.
 */
export const PRICE_MAP_VERSION = '2026-06-24'

export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
}

export const PRICE_MAP: Readonly<Record<string, ModelRate>> = Object.freeze({
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  // Sonnet 5 carries a lower introductory rate ($2/$10) through 2026-08-31.
  // We price it at the standard rate on purpose: for a spend ceiling, erring
  // high is the safe direction, and date-dependent rates would make every
  // stored figure depend on when it was computed. Sonnet is ~2.4% of fleet
  // spend, so the resulting overstatement is well under 1% of the total.
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
})

/**
 * Cache tokens are billed as multiples of the model's input rate: reads at
 * ~0.1x, 5-minute writes at ~1.25x. These are not incidental.
 *
 * Measured over the fleet's 7 days to 2026-07-31: cache_read is 82.9% of total
 * list-price-equivalent spend, cache_write 9.5%, output 7.6%, input 0.0%. A
 * cost formula that counts only input+output -- the obvious one to write -- sees
 * 7.6% of the real figure and understates by roughly 13x. That is the single
 * error this module exists to prevent, which is why these two multipliers are
 * named constants rather than inline numbers.
 */
export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_MULTIPLIER = 1.25

/** The token counters a usage row contributes to cost. */
export interface TokenCounts {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
}

/** Per-component USD breakdown; components sum to `total`. */
export interface TokenCostComponents {
  input: number
  output: number
  cache_read: number
  cache_write: number
  total: number
}

export const ZERO_COMPONENTS: Readonly<TokenCostComponents> = Object.freeze({
  input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0,
})

/** True if we hold a published rate for this model id. */
export function isPriced(model: string | null | undefined): boolean {
  return typeof model === 'string' && Object.hasOwn(PRICE_MAP, model)
}

/**
 * List-price-equivalent USD for one row's token counts.
 *
 * Returns null -- never a zero cost -- for a model with no published rate
 * (an unrecognised id, or a sentinel like `<synthetic>`). Charging an unknown
 * model $0 would be a silent no-op of exactly the kind this subsystem is meant
 * to surface: the total would still look like a total, quietly missing whatever
 * the unpriced traffic was worth. Callers must account for the null explicitly.
 */
export function priceTokens(
  model: string | null | undefined,
  counts: TokenCounts,
): TokenCostComponents | null {
  if (!isPriced(model)) return null
  const rate = PRICE_MAP[model as string]
  const input = (counts.input_tokens * rate.input) / 1e6
  const output = (counts.output_tokens * rate.output) / 1e6
  const cache_read = (counts.cache_read_tokens * rate.input * CACHE_READ_MULTIPLIER) / 1e6
  const cache_write = (counts.cache_creation_tokens * rate.input * CACHE_WRITE_MULTIPLIER) / 1e6
  return { input, output, cache_read, cache_write, total: input + output + cache_read + cache_write }
}

/**
 * Calendar-day key for an epoch-second timestamp in a named IANA zone.
 *
 * The zone is an explicit parameter rather than the process default so tests
 * are deterministic regardless of the machine's TZ. It defaults to the install
 * timezone because a "daily cap" is a wall-clock concept for the operator:
 * bucketing by UTC would move the boundary to 01:00 or 02:00 local and quietly
 * split a working evening across two days. Note this differs from the money
 * ledger's monthWindow(), which is UTC by design -- the two are not interchangeable.
 */
export function dayKey(epochSeconds: number, timeZone = 'Europe/Budapest'): string {
  // 'en-CA' formats as YYYY-MM-DD, which sorts lexicographically.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epochSeconds * 1000))
}
