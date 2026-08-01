// CostOps v0.1 -- read-mostly HTTP API. Bearer-gated like every /api/* route.
// GET never writes: reflecting the local config's fixed costs into the ledger
// (an idempotent upsert by dedup_key) happens on its own schedule via
// startCostsSyncTask() below (called once at server boot), not as a side effect
// of a client request. No LLM, no provider API, no secrets in the response.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig, availableDisplayCurrencies } from '../../costops/config.js'
import { refreshFxRates } from '../../costops/fx-rates.js'
import { syncFixedCostsToLedger, getCostSummary, getCostSources, getTokenCostReport } from '../../costops/ledger.js'
import { PRICE_MAP, isPriced } from '../../costops/pricing.js'
import { applyEcoMode, readEcoState, baseModelId, DEFAULT_ECO_MODEL } from '../../costops/eco-mode.js'
import { getContextAttribution } from '../../costops/context-attribution.js'
import { runQuotaGuard, readQuotaState, WARN_THRESHOLD, CRITICAL_THRESHOLD } from '../../costops/quota-guard.js'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RouteContext } from './types.js'

// Runs the fixed-cost -> ledger reflection once immediately (so the summary is
// fresh from the moment the server comes up) and then on a fixed interval, so a
// manual edit to the local costops config eventually shows up without needing a
// restart. 10 minutes is deliberately coarse -- this is a manually-edited local
// config file, not something that needs near-real-time reflection, and this is
// the only place in the whole CostOps slice that writes to the DB at all.
const SYNC_INTERVAL_MS = 10 * 60 * 1000

export function startCostsSyncTask(intervalMs = SYNC_INTERVAL_MS): NodeJS.Timeout {
  const sync = () => {
    try {
      const { config } = loadCostopsConfig()
      syncFixedCostsToLedger(getDb(), config, Math.floor(Date.now() / 1000))
    } catch (err) {
      logger.warn({ err }, 'CostOps fixed-cost sync failed')
    }
  }
  sync()
  return setInterval(sync, intervalMs).unref()
}

// Daily FX refresh. Polls hourly and lets refreshFxRates() decide whether the
// day's fetch is due -- rather than firing at a fixed hour, which a restart or
// a machine asleep at that minute would simply skip. Weekends are skipped by
// the same decision (the ECB does not publish), so this loop stays dumb.
const FX_POLL_INTERVAL_MS = 60 * 60 * 1000

export function startFxRefreshTask(intervalMs = FX_POLL_INTERVAL_MS): NodeJS.Timeout {
  const tick = () => {
    void refreshFxRates()
      .then(outcome => {
        // 'skipped' is the normal case on most ticks; logging it would bury the
        // two outcomes that matter.
        if (outcome.status === 'failed') {
          logger.warn({ context: { action: 'fx_refresh_failed' }, error: outcome.error }, 'FX refresh failed; previous rates kept')
        }
      })
      .catch(err => logger.warn({ err }, 'FX refresh threw unexpectedly'))
  }
  tick()
  return setInterval(tick, intervalMs).unref()
}

export async function tryHandleCosts(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/costs/summary' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadCostopsConfig()
      // An unsupported display currency is refused rather than served as a
      // page full of nulls: without a rate every figure would be "cannot say",
      // which reads like missing data instead of a bad request.
      const requested = (url.searchParams.get('display_currency') || '').trim().toUpperCase()
      const available = availableDisplayCurrencies(config)
      if (requested && !available.includes(requested)) {
        json(res, { error: `No rate for ${requested}`, available }, 400)
        return true
      }
      const summary = getCostSummary(getDb(), config, now, {
        monthKey, configExists: exists, configErrors: errors,
        displayCurrency: requested || undefined,
      })
      json(res, summary)
    } catch (err) {
      logger.error({ err }, 'CostOps summary failed')
      json(res, { error: 'Cost summary failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/sources' && method === 'GET') {
    try {
      json(res, getCostSources(getDb()))
    } catch (err) {
      logger.error({ err }, 'CostOps sources failed')
      json(res, { error: 'Cost sources failed' }, 500)
    }
    return true
  }

  // Token list-price equivalent over a rolling window. `days` (default 7,
  // max 400) is a rolling lookback rather than a calendar month so a daily
  // ceiling can be evaluated without a month-boundary special case.
  if (path === '/api/costs/tokens' && method === 'GET') {
    try {
      const raw = Number(url.searchParams.get('days') ?? '7')
      const days = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 400) : 7
      const now = Math.floor(Date.now() / 1000)
      json(res, getTokenCostReport(getDb(), { start: now - days * 86400, end: now }))
    } catch (err) {
      logger.error({ err }, 'CostOps token cost failed')
      json(res, { error: 'Token cost failed' }, 500)
    }
    return true
  }

  // Eco mode. GET previews, POST applies. Neither restarts an agent: a model
  // change only lands on the next restart, and that stays an operator call.
  if (path === '/api/costs/eco' && method === 'GET') {
    try {
      const state = readEcoState()
      const target = url.searchParams.get('target') || DEFAULT_ECO_MODEL
      json(res, {
        state,
        preview: applyEcoMode(!state.enabled, target, { dryRun: true }),
      })
    } catch (err) {
      logger.error({ err }, 'CostOps eco preview failed')
      json(res, { error: 'Eco preview failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/eco' && method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const enable = body.enabled === true
      const target = typeof body.target === 'string' && body.target ? body.target : DEFAULT_ECO_MODEL
      // An unrecognised model string is not a harmless typo: the agent's next
      // launch fails on it. Refuse rather than write one into a live config.
      if (enable && !isPriced(baseModelId(target))) {
        json(res, { error: `Unknown eco target model: ${target}`, known: Object.keys(PRICE_MAP) }, 400)
        return true
      }
      json(res, applyEcoMode(enable, target, { dryRun: body.dry_run === true }))
    } catch (err) {
      logger.error({ err }, 'CostOps eco apply failed')
      json(res, { error: 'Eco apply failed' }, 500)
    }
    return true
  }

  // What a scheduled task pays for: context inherited from its host session
  // versus its own work, plus the priced fresh-session alternative.
  if (path === '/api/costs/context-attribution' && method === 'GET') {
    try {
      const raw = Number(url.searchParams.get('days') ?? '30')
      const days = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 400) : 30
      // The schedule directory is the authoritative list of marker-labelled
      // task names. Filtering by it keeps correlateWithKanban()'s time-window
      // card titles -- a guess, not an attribution -- out of the cost figures.
      let tasks: string[] = []
      try { tasks = readdirSync(join(homedir(), '.claude', 'scheduled-tasks')) } catch { tasks = [] }
      const now = Math.floor(Date.now() / 1000)
      json(res, getContextAttribution(getDb(), { start: now - days * 86400, end: now, tasks }))
    } catch (err) {
      logger.error({ err }, 'CostOps context attribution failed')
      json(res, { error: 'Context attribution failed' }, 500)
    }
    return true
  }

  // Subscription quota. Report only: this GET classifies but never switches
  // eco mode or sends an alert -- acting is the periodic guard's job, so a
  // dashboard refresh cannot trip the fleet into eco mode.
  if (path === '/api/costs/quota' && method === 'GET') {
    try {
      const result = await runQuotaGuard({ act: false, readState: () => readQuotaState() })
      json(res, {
        ...result,
        thresholds: { warning: WARN_THRESHOLD, critical: CRITICAL_THRESHOLD },
        state: readQuotaState(),
      })
    } catch (err) {
      logger.error({ err }, 'CostOps quota read failed')
      json(res, { error: 'Quota read failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/budgets' && method === 'GET') {
    try {
      const { config } = loadCostopsConfig()
      json(res, config.budgets)
    } catch (err) {
      logger.error({ err }, 'CostOps budgets failed')
      json(res, { error: 'Cost budgets failed' }, 500)
    }
    return true
  }

  return false
}
