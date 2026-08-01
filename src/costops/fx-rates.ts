// CostOps -- daily FX rate refresh for the cost config.
//
// The per-project cost view needs a rate table to show one total instead of a
// figure per currency. The owner declined to maintain it by hand (kanban #167),
// so it is fetched -- with the guards that a number entering a financial table
// deserves.
//
// WHY THIS RUNS IN THE SERVICE, NOT AS A SCHEDULED AGENT TASK: pulling two
// numbers and writing a JSON file needs no model. A scheduled task would spend
// an LLM turn on arithmetic, and CostOps is deterministic by design. It sits
// next to the fixed-cost sync in routes/costs.ts for the same reason.
//
// The rest of this module is pure: parsing, sanity checks and the merge are
// separate from the fetch and the write, so every rule below is unit-tested
// against a fixed payload rather than against the live internet.

import { readFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { COSTOPS_CONFIG_PATH } from './config.js'
import { logger } from '../logger.js'

/**
 * Rate source: the ECB daily reference rates, via frankfurter.app.
 *
 * Chosen over the MNB (the Hungarian central bank) deliberately, and the
 * choice is recorded in the config as `fx_source` so a number can always be
 * traced to where it came from:
 *   - no API key, plain REST, published by the ECB itself;
 *   - the MNB's is a SOAP service, and its rate is what Hungarian ACCOUNTING
 *     requires -- this table is a management view of what the projects cost,
 *     not a filing. If it ever feeds bookkeeping, switch the source and say so
 *     in `fx_source`, because then the difference matters.
 *
 * The URL is a constant, not configuration. A configurable endpoint would turn
 * a cost feature into an arbitrary outbound request, which is not something a
 * config edit should be able to do.
 */
export const FX_SOURCE_URL = 'https://api.frankfurter.app/latest?base=EUR&symbols=HUF,USD'
export const FX_SOURCE_NAME = 'ECB via frankfurter.app'
const FETCH_TIMEOUT_MS = 10_000

export interface FxRates {
  /** Units of the display currency (HUF) per 1 unit of the foreign currency. */
  USD: number
  EUR: number
}

export interface FxSnapshot {
  rates: FxRates
  /** The date the SOURCE published these rates -- not when we fetched them. */
  asof: string
}

/**
 * Turn the EUR-based payload into HUF-per-unit rates.
 *
 * The API quotes everything against one base, so USD/HUF is a cross rate:
 * (HUF per EUR) / (USD per EUR). Doing this here, in a tested function, is the
 * point -- an inverted cross rate is the classic way to get a plausible number
 * that is wrong by a factor of 100 000.
 */
export function parseFrankfurter(payload: unknown): FxSnapshot | null {
  const p = payload as { base?: unknown; date?: unknown; rates?: Record<string, unknown> } | null
  if (!p || typeof p !== 'object') return null
  if (p.base !== 'EUR') return null
  if (typeof p.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return null
  const huf = p.rates?.HUF
  const usd = p.rates?.USD
  if (typeof huf !== 'number' || typeof usd !== 'number') return null
  if (!isFinite(huf) || !isFinite(usd) || huf <= 0 || usd <= 0) return null
  return {
    asof: p.date,
    rates: { EUR: round4(huf), USD: round4(huf / usd) },
  }
}

/**
 * Plausible bands for HUF rates, deliberately wide.
 *
 * These are not forecasts: they are a floor and ceiling that no real rate has
 * been near in decades, so they catch a wrong base, an inverted cross rate, or
 * an error page parsed as numbers -- without rejecting a genuine market move.
 */
export const SANITY_BANDS: Record<keyof FxRates, { min: number; max: number }> = {
  USD: { min: 150, max: 900 },
  EUR: { min: 200, max: 1000 },
}

/** A day-over-day jump larger than this is treated as bad data, not a market move. */
export const MAX_DAILY_DRIFT = 0.15

export interface SanityResult {
  ok: boolean
  reasons: string[]
}

/**
 * Would writing these rates be safe?
 *
 * Refusing is always the safe side: the previous rates stay, `fx_asof` keeps
 * showing their (older) date, and the operator can see the staleness. A bad
 * rate written silently is invisible -- every figure downstream just becomes
 * wrong by a factor.
 */
export function sanityCheck(next: FxRates, previous?: Partial<FxRates>): SanityResult {
  const reasons: string[] = []
  for (const key of ['USD', 'EUR'] as const) {
    const value = next[key]
    const band = SANITY_BANDS[key]
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) {
      reasons.push(`${key}: not a positive number`)
      continue
    }
    if (value < band.min || value > band.max) {
      reasons.push(`${key}: ${value} outside plausible band ${band.min}-${band.max}`)
      continue
    }
    const prev = previous?.[key]
    if (typeof prev === 'number' && prev > 0) {
      const drift = Math.abs(value - prev) / prev
      if (drift > MAX_DAILY_DRIFT) {
        reasons.push(`${key}: ${(drift * 100).toFixed(1)}% jump from ${prev} (max ${(MAX_DAILY_DRIFT * 100).toFixed(0)}%)`)
      }
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Should we go out and look today?
 *
 * The ECB publishes on working days only, so a weekend check would fetch
 * Friday's numbers again and again. `lastCheckedOn` is when we last LOOKED,
 * kept separate from `fx_asof` (when the rates were PUBLISHED): after a
 * holiday the source legitimately returns an older date, and conflating the
 * two would make the updater retry every hour forever.
 */
export function shouldRefresh(now: Date, lastCheckedOn: string | undefined): boolean {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  return localDateKey(now) !== lastCheckedOn
}

/** YYYY-MM-DD in the host's local timezone, which is the install's timezone. */
export function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Merge new rates into the config, preserving everything else.
 *
 * Takes and returns plain objects: the config file holds the operator's own
 * cost entries, and a refresh that dropped a key -- or reformatted their file
 * -- would be a far worse bug than a stale rate.
 */
export function applyFxUpdate(
  config: Record<string, unknown>,
  snapshot: FxSnapshot,
  checkedOn: string,
): Record<string, unknown> {
  const existingRates = (config.fx_rates && typeof config.fx_rates === 'object')
    ? config.fx_rates as Record<string, number>
    : {}
  return {
    ...config,
    fx_rates: { ...existingRates, USD: snapshot.rates.USD, EUR: snapshot.rates.EUR },
    fx_asof: snapshot.asof,
    fx_checked_on: checkedOn,
    fx_source: FX_SOURCE_NAME,
  }
}

export type RefreshOutcome =
  | { status: 'updated'; rates: FxRates; asof: string }
  | { status: 'skipped'; reason: 'not_due' | 'no_config' }
  | { status: 'rejected'; reasons: string[] }
  | { status: 'failed'; error: string }

/**
 * One refresh cycle. Never throws: a rate refresh must not be able to take the
 * dashboard down, and a network blip is an ordinary event, not an incident.
 *
 * Writes NOTHING when the config file does not exist -- the config is the
 * operator's file, and creating one from a rate fetch would put a half-formed
 * cost config on disk that looks configured but has no costs in it.
 */
export async function refreshFxRates(opts: {
  now?: Date
  fetchImpl?: typeof fetch
  configPath?: string
} = {}): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date()
  const path = opts.configPath ?? COSTOPS_CONFIG_PATH
  const doFetch = opts.fetchImpl ?? fetch

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return { status: 'skipped', reason: 'no_config' }
  }
  let config: Record<string, unknown>
  try {
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // A malformed config is the operator's to fix; rewriting it from here
    // would destroy whatever they were in the middle of typing.
    return { status: 'failed', error: 'config is not valid JSON' }
  }

  const checkedOn = typeof config.fx_checked_on === 'string' ? config.fx_checked_on : undefined
  if (!shouldRefresh(now, checkedOn)) return { status: 'skipped', reason: 'not_due' }

  let snapshot: FxSnapshot | null
  try {
    const res = await doFetch(FX_SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return { status: 'failed', error: `HTTP ${res.status}` }
    snapshot = parseFrankfurter(await res.json())
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'unknown' }
  }
  if (!snapshot) return { status: 'failed', error: 'unexpected payload shape' }

  const previous = (config.fx_rates && typeof config.fx_rates === 'object')
    ? config.fx_rates as Partial<FxRates>
    : undefined
  const sanity = sanityCheck(snapshot.rates, previous)
  if (!sanity.ok) {
    // Deliberately does not stamp fx_checked_on: a rejected fetch should be
    // retried on the next tick, not treated as "handled for today".
    logger.warn({ context: { action: 'fx_refresh_rejected' }, reasons: sanity.reasons }, 'FX rates rejected by sanity check; keeping previous rates')
    return { status: 'rejected', reasons: sanity.reasons }
  }

  const updated = applyFxUpdate(config, snapshot, localDateKey(now))
  atomicWriteFileSync(path, JSON.stringify(updated, null, 2) + '\n')
  logger.info({ context: { action: 'fx_refresh_updated' }, rates: snapshot.rates, asof: snapshot.asof }, 'FX rates refreshed')
  return { status: 'updated', rates: snapshot.rates, asof: snapshot.asof }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000
