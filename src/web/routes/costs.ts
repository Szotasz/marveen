// CostOps v0.1 -- read-mostly HTTP API. Bearer-gated like every /api/* route.
// GET never writes: reflecting the local config's fixed costs into the ledger
// (an idempotent upsert by dedup_key) happens on its own schedule via
// startCostsSyncTask() below (called once at server boot), not as a side effect
// of a client request. No LLM, no provider API, no secrets in the response.

import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig } from '../../costops/config.js'
import { syncFixedCostsToLedger, getCostSummary, getCostSources } from '../../costops/ledger.js'
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

export async function tryHandleCosts(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/costs/summary' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadCostopsConfig()
      const summary = getCostSummary(getDb(), config, now, {
        monthKey, configExists: exists, configErrors: errors,
      })
      json(res, summary)
    } catch (err) {
      logger.error({ err }, 'CostOps summary failed')
      json(res, { error: 'Cost summary failed' }, 500)
    }
    return true
  }

  // v0.5: sync spine -- run the Render collector LIVE (read-only GET) + idempotent import.
  // Bearer-gated (like every /api/*). NO provider-side write; same-month re-run is idempotent.
  if (path === '/api/costs/sync' && method === 'POST') {
    try {
      const provider = url.searchParams.get('provider') || 'render'
      const now = Math.floor(Date.now() / 1000)
      const db = getDb()
      let result: { ok: boolean }
      if (provider === 'render') {
        const { syncRenderCollector } = await import('../../costops/collectors/render.js')
        result = await syncRenderCollector(db, now)
      } else if (provider === 'openai') {
        // LIVE read-only OpenAI Costs API sync; admin key pulled from the Vault, never logged.
        const { syncOpenAiCollector } = await import('../../costops/collectors/openai.js')
        result = await syncOpenAiCollector(db, now)
      } else if (provider === 'github') {
        // LIVE read-only GitHub billing usage sync; PAT pulled from the Vault, never logged.
        const { syncGitHubCollector } = await import('../../costops/collectors/github.js')
        result = await syncGitHubCollector(db, now)
      } else {
        json(res, { error: `unsupported provider '${provider}' (supported: render, openai, github)` }, 400); return true
      }
      json(res, result, result.ok ? 200 : 502)
    } catch (err) {
      logger.error({ err }, 'CostOps sync failed')
      json(res, { ok: false, error: 'sync failed' }, 500)
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
