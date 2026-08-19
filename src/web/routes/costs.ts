// CostOps v0.1 -- read-mostly HTTP API. Bearer-gated like every /api/* route.
// No writes from the client: the only DB write is an idempotent reconciliation
// of the local config's fixed costs into the ledger on a summary read. No LLM,
// no provider API, no secrets in the response.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { loadCostopsConfig } from '../../costops/config.js'
import { loadPricingConfig } from '../../costops/pricing.js'
import { syncFixedCostsToLedger, getCostSummary, getCostSources, monthWindow } from '../../costops/ledger.js'
import { getPeriodTrend } from '../../costops/period.js'
import { loadSubscriptionsConfig, deriveLifecycle } from '../../costops/subscriptions.js'
import { getWarnings } from '../../costops/warnings.js'
import {
  exportCostRows, rowsToCsv, exportSourceInventory, sourceInventoryToCsv,
  exportProviderSummary, providerSummaryToCsv, exportCategorySummary, categorySummaryToCsv,
  exportBudgetVariance, exportReconciliationReport, reconciliationReportToCsv,
  exportForecastHistory, exportDataQualityReport, exportMonthlySnapshot,
  exportAlerts, alertsToCsv,
} from '../../costops/export.js'
import { ingestWorkspaceAlerts, buildWorkspaceAlertWarnings } from '../../costops/workspace-alerts.js'
import { loadDomainsConfig } from '../../costops/expiry-checks.js'
import { getTokenCostByAgent } from '../../costops/pricing.js'
import { getLimitStatus, getLiveCheckWarnings } from '../../costops/limits.js'
import { buildSourceInventory } from '../../costops/inventory.js'
import { captureReliabilitySnapshot, listReliabilitySnapshots, getLatestReliabilitySnapshot } from '../../costops/reliability-observation.js'
import { listForecastSnapshots } from '../../costops/forecast-capture.js'
import { buildReconciliation } from '../../costops/reconciliation.js'
import { createCorrection, getCorrectionChain } from '../../costops/correction.js'
import { listAlerts, acknowledgeAlertByKey, resolveAlertByKey } from '../../costops/alerts-store.js'
import { getPeriodStatus, checkCloseReadiness, closePeriod, reopenPeriod, getPeriodCloseHistory, getCloseSnapshot } from '../../costops/period-close.js'
import { getAllBudgetStatuses, upsertBudget, deleteBudget, getBudgetAuditHistory } from '../../costops/budgets.js'
import { listRecommendations, acceptRecommendationByKey, dismissRecommendationByKey, type ListRecommendationsOptions } from '../../costops/recommendations-store.js'
import { recordInvoice, applyInvoiceAdjustment, voidInvoice, listInvoices, buildInvoiceReconciliation } from '../../costops/invoice.js'
import type { RouteContext } from './types.js'

// Runs the fixed-cost -> ledger reflection once immediately (so the summary is
// fresh from the moment the server comes up) and then on a fixed interval.
// 10 minutes is deliberately coarse.
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
      } else if (provider === 'deepseek') {
        // LIVE read-only DeepSeek prepaid-balance sync; key from the Vault, never logged.
        const { syncDeepSeekBalance } = await import('../../costops/collectors/deepseek.js')
        result = await syncDeepSeekBalance(db, now)
      } else if (provider === 'codex') {
        // LIVE read-only Codex/ChatGPT-Plus weekly rate-limit sync via the codex
        // app-server metadata read (account/rateLimits/read) -- zero quota, no LLM.
        const { syncCodexRateLimit } = await import('../../costops/collectors/codex.js')
        result = await syncCodexRateLimit(db, now)
      } else {
        json(res, { error: `unsupported provider '${provider}' (supported: render, openai, github, deepseek, codex)` }, 400); return true
      }
      json(res, result, result.ok ? 200 : 502)
    } catch (err) {
      logger.error({ err }, 'CostOps sync failed')
      json(res, { ok: false, error: 'sync failed' }, 500)
    }
    return true
  }

  // Email-sourced cost ingest: an agent-side Gmail sweep POSTs structured receipt
  // entries here. Idempotent per (email, month). No raw email content is stored.
  if (path === '/api/costs/email-ingest' && method === 'POST') {
    try {
      const body = await readBody(ctx.req) as { entries?: unknown }
      const entries = Array.isArray(body?.entries) ? body.entries : []
      const now = Math.floor(Date.now() / 1000)
      let fxUsdHuf = 0
      try { const { loadRenderPricing } = await import('../../costops/collectors/render.js'); fxUsdHuf = loadRenderPricing().pricing.fx_usd_huf || 0 } catch { /* fx 0 -> USD entries flagged */ }
      const { ingestEmailCosts } = await import('../../costops/email-ingest.js')
      const result = ingestEmailCosts(getDb(), entries as import('../../costops/email-ingest.js').EmailCostEntry[], { fxUsdHuf, now })
      json(res, { ok: result.errors.length === 0, ...result })
    } catch (err) {
      logger.error({ err }, 'CostOps email-ingest failed')
      json(res, { ok: false, error: 'email-ingest failed' }, 500)
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

  // Phase 0 (GAP-03/GAP-04): full source inventory -- lifecycle + provenance +
  // freshness + sync cadence + owner + blocker per source, so period close/
  // reconciliation/alerts (later phases) have an unambiguous per-source status
  // to build on. Additive: does not change /summary's contract.
  if (path === '/api/costs/source-inventory' && method === 'GET') {
    try {
      const { config } = loadCostopsConfig()
      const now = Math.floor(Date.now() / 1000)
      json(res, { sources: buildSourceInventory(getDb(), config, now), generated_at: now })
    } catch (err) {
      logger.error({ err }, 'CostOps source-inventory failed')
      json(res, { error: 'Source inventory failed' }, 500)
    }
    return true
  }

  // Phase 0 (GAP-21 P0.5): 7-day source-reliability observation window. POST
  // captures one snapshot (idempotent-ish in effect, not in storage -- each
  // call adds a new dated row, matching "one observation per day" usage);
  // GET lists the accumulated window so far, or returns just the latest full
  // inventory with ?latest=1.
  if (path === '/api/costs/reliability-snapshots' && method === 'POST') {
    try {
      const { config } = loadCostopsConfig()
      const now = Math.floor(Date.now() / 1000)
      const snap = captureReliabilitySnapshot(getDb(), config, now)
      json(res, { captured_at: snap.captured_at, source_count: snap.source_count })
    } catch (err) {
      logger.error({ err }, 'CostOps reliability-snapshot capture failed')
      json(res, { error: 'Reliability snapshot capture failed' }, 500)
    }
    return true
  }
  if (path === '/api/costs/reliability-snapshots' && method === 'GET') {
    try {
      const db = getDb()
      if (url.searchParams.get('latest') === '1') {
        json(res, getLatestReliabilitySnapshot(db) ?? { captured_at: null, source_count: 0, inventory: [] })
      } else {
        json(res, { snapshots: listReliabilitySnapshots(db) })
      }
    } catch (err) {
      logger.error({ err }, 'CostOps reliability-snapshots list failed')
      json(res, { error: 'Reliability snapshots list failed' }, 500)
    }
    return true
  }

  // Phase 1 (GAP-10): forecast snapshots -- Anvil's forecast.ts computation +
  // Mason's forecast-capture.ts orchestration. ?month=YYYY-MM filters; default
  // returns the most recent 200 rows across all months.
  if (path === '/api/costs/forecast-snapshots' && method === 'GET') {
    try {
      const month = url.searchParams.get('month') || undefined
      json(res, { snapshots: listForecastSnapshots(getDb(), { month }) })
    } catch (err) {
      logger.error({ err }, 'CostOps forecast-snapshots list failed')
      json(res, { error: 'Forecast snapshots list failed' }, 500)
    }
    return true
  }

  // Phase 1 (GAP-06): per-source reconciliation view (expected/observed/
  // invoice/operationally-selected amount + variance + status). Read-only.
  if (path === '/api/costs/reconciliation' && method === 'GET') {
    try {
      const month = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      json(res, { reconciliation: buildReconciliation(getDb(), now, month) })
    } catch (err) {
      logger.error({ err }, 'CostOps reconciliation failed')
      json(res, { error: 'Reconciliation failed' }, 500)
    }
    return true
  }

  // Phase 2 (GAP-13): monthly close/reopen workflow. GET returns status +
  // close-readiness checklist + audit history (+ the immutable snapshot if
  // closed); POST /close and /reopen are the two audited state transitions.
  if (path === '/api/costs/period-close' && method === 'GET') {
    try {
      const month = url.searchParams.get('month')
      if (!month) { json(res, { error: 'missing ?month=YYYY-MM' }, 400); return true }
      const { config } = loadCostopsConfig()
      const now = Math.floor(Date.now() / 1000)
      const db = getDb()
      const status = getPeriodStatus(db, month)
      const readiness = checkCloseReadiness(db, config, now, month)
      const history = getPeriodCloseHistory(db, month)
      const snapshot = status === 'closed' || status === 'reopened' ? getCloseSnapshot(db, month) : null
      json(res, { month, status, readiness, history, snapshot })
    } catch (err) {
      logger.error({ err }, 'CostOps period-close status failed')
      json(res, { error: 'Period-close status failed' }, 500)
    }
    return true
  }
  if (path === '/api/costs/period-close/close' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const { config } = loadCostopsConfig()
      const now = Math.floor(Date.now() / 1000)
      const result = closePeriod(getDb(), config, body.month, body.actor, body.reason ?? null, now, { force: body.force === true })
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps period close failed')
      json(res, { ok: false, error: 'period close failed' }, 500)
    }
    return true
  }
  if (path === '/api/costs/period-close/reopen' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = reopenPeriod(getDb(), body.month, body.actor, body.reason, now)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps period reopen failed')
      json(res, { ok: false, error: 'period reopen failed' }, 500)
    }
    return true
  }

  // Phase 1 (GAP-05/GAP-06/GAP-14): correction relationship for any ledger
  // line (extends Phase 0's manual-only void/archive). POST creates a
  // correction (voids the original, links a new row via corrects_line_id);
  // GET ?chain=<lineId> walks the full correction chain for drill-down.
  if (path === '/api/costs/corrections' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = createCorrection(getDb(), {
        originalLineId: Number(body.originalLineId), newAmount: Number(body.newAmount), reason: body.reason,
      }, { now })
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps correction failed')
      json(res, { ok: false, error: 'correction failed' }, 500)
    }
    return true
  }
  if (path === '/api/costs/corrections' && method === 'GET') {
    try {
      const lineId = Number(url.searchParams.get('chain'))
      if (!Number.isFinite(lineId) || lineId <= 0) {
        json(res, { error: 'missing or invalid ?chain=<lineId>' }, 400); return true
      }
      json(res, { chain: getCorrectionChain(getDb(), lineId) })
    } catch (err) {
      logger.error({ err }, 'CostOps correction-chain lookup failed')
      json(res, { error: 'Correction chain lookup failed' }, 500)
    }
    return true
  }

  // Phase 3 (GAP-12): deterministic alert lifecycle, persisted via
  // alerts-store.ts. Reads whatever is currently stored -- population (the
  // 13-detector signal-gathering round) is a separate orchestration piece
  // (alerts-capture.ts) not yet wired into the boot seam.
  if (path === '/api/costs/alerts' && method === 'GET') {
    try {
      const status = (url.searchParams.get('status') as 'active' | 'resolved' | 'all' | null) ?? undefined
      const type = url.searchParams.get('type') || undefined
      json(res, { alerts: listAlerts(getDb(), { status, type }) })
    } catch (err) {
      logger.error({ err }, 'CostOps alerts list failed')
      json(res, { error: 'Alerts list failed' }, 500)
    }
    return true
  }
  if (path === '/api/costs/alerts/acknowledge' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = acknowledgeAlertByKey(getDb(), body.dedup_key, body.actor || 'unknown', now)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps alert acknowledge failed')
      json(res, { ok: false, error: 'alert acknowledge failed' }, 500)
    }
    return true
  }
  if (path === '/api/costs/alerts/resolve' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = resolveAlertByKey(getDb(), body.dedup_key, now)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps alert resolve failed')
      json(res, { ok: false, error: 'alert resolve failed' }, 500)
    }
    return true
  }

  // Phase 3 (GAP-11): every configured budget's LIVE status (current_spend/
  // forecast/variance/status against its scope), not just the raw config
  // entries -- same shape as what period-close's immutable snapshot bundles.
  if (path === '/api/costs/budgets' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config } = loadCostopsConfig()
      const statuses = getAllBudgetStatuses(getDb(), config, now, monthKey)
      json(res, statuses)
    } catch (err) {
      logger.error({ err }, 'CostOps budgets failed')
      json(res, { error: 'Cost budgets failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/budgets' && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const { config } = loadCostopsConfig()
      const result = (method === 'POST' || method === 'PATCH')
        ? upsertBudget(getDb(), config, body, body.actor, now)
        : deleteBudget(getDb(), config, body.id, body.actor, now)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps budget change failed')
      json(res, { ok: false, error: 'budget change failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/budgets/history' && method === 'GET') {
    try {
      const budgetId = url.searchParams.get('id') || undefined
      const history = getBudgetAuditHistory(getDb(), budgetId)
      json(res, history)
    } catch (err) {
      logger.error({ err }, 'CostOps budget history failed')
      json(res, { error: 'Cost budget history failed' }, 500)
    }
    return true
  }

  // Phase 4 (GAP-17): aggregate cost optimization advisor. Reads only --
  // recommendations are populated by optimization-capture.ts's future daily
  // cycle (mirroring alerts-capture.ts), not by this route. Defaults to
  // 'open' (unaddressed) recommendations, same convention as GET /api/costs/alerts.
  if (path === '/api/costs/recommendations' && method === 'GET') {
    try {
      const status = (url.searchParams.get('status') || undefined) as ListRecommendationsOptions['status']
      const type = url.searchParams.get('type') || undefined
      const recommendations = listRecommendations(getDb(), { status, type })
      json(res, { recommendations })
    } catch (err) {
      logger.error({ err }, 'CostOps recommendations failed')
      json(res, { error: 'Cost recommendations failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/recommendations/accept' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = acceptRecommendationByKey(getDb(), body.dedup_key, body.actor, now)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps recommendation accept failed')
      json(res, { ok: false, error: 'recommendation accept failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/recommendations/dismiss' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = dismissRecommendationByKey(getDb(), body.dedup_key, body.actor, now)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps recommendation dismiss failed')
      json(res, { ok: false, error: 'recommendation dismiss failed' }, 500)
    }
    return true
  }

  // Phase 2 (GAP-14): invoice / credit / refund / correction workflow.
  // 'invoice-salt' matches this codebase's existing per-domain idSalt
  // convention (collectors/openai.ts's 'openai-salt' etc.) -- a namespacing
  // salt for hashRef, not a secret.
  if (path === '/api/costs/invoices' && method === 'GET') {
    try {
      const sourceId = url.searchParams.get('source_id') || undefined
      const month = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const invoices = listInvoices(getDb(), { source_id: sourceId, month, now })
      json(res, { invoices })
    } catch (err) {
      logger.error({ err }, 'CostOps invoices list failed')
      json(res, { error: 'Cost invoices failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/invoices' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = recordInvoice(getDb(), body, { now, salt: 'invoice-salt' })
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps invoice record failed')
      json(res, { ok: false, error: 'invoice record failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/invoices/adjust' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = applyInvoiceAdjustment(getDb(), body, { now })
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps invoice adjustment failed')
      json(res, { ok: false, error: 'invoice adjustment failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/invoices/void' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const result = voidInvoice(getDb(), body.invoiceId, body.reason, now)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps invoice void failed')
      json(res, { ok: false, error: 'invoice void failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/invoices/reconciliation' && method === 'GET') {
    try {
      const now = Math.floor(Date.now() / 1000)
      const month = url.searchParams.get('month') || undefined
      const reconciliation = await buildInvoiceReconciliation(getDb(), now, month)
      json(res, { reconciliation })
    } catch (err) {
      logger.error({ err }, 'CostOps invoice reconciliation failed')
      json(res, { error: 'Cost invoice reconciliation failed' }, 500)
    }
    return true
  }

  // v0.7: monthly close / period view -- current + previous + last-N trend,
  // per provider. READ-ONLY (no fixed-cost sync), so a month before a
  // subscription existed correctly reports no_data, never a fabricated 0.
  if (path === '/api/costs/period' && method === 'GET') {
    try {
      const monthsBack = Math.min(Math.max(parseInt(url.searchParams.get('months') || '6', 10) || 6, 1), 24)
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config } = loadCostopsConfig()
      const trend = getPeriodTrend(getDb(), config, now, monthsBack, monthKey)
      json(res, trend)
    } catch (err) {
      logger.error({ err }, 'CostOps period failed')
      json(res, { error: 'Cost period failed' }, 500)
    }
    return true
  }

  // v0.7: subscription lifecycle (active/canceled/paid_until/next_renewal),
  // config-derived facts only -- no Gmail access, no raw email/PII.
  if (path === '/api/costs/subscriptions' && method === 'GET') {
    try {
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadSubscriptionsConfig()
      json(res, { subscriptions: deriveLifecycle(config, now), config_present: exists, config_errors: errors })
    } catch (err) {
      logger.error({ err }, 'CostOps subscriptions failed')
      json(res, { error: 'Cost subscriptions failed' }, 500)
    }
    return true
  }

  // v0.8 (card 6f4d1332 §5/§6.2): agent-grouped token cost + run-rate forecast, and the
  // normalized limits/quota pass (subscription lifecycle + DeepSeek balance + workspace alerts +
  // Render build-minutes + SSL/domain expiry, all into one shape). Separate from /summary so a
  // live TLS/RDAP/Render round trip never slows down the primary (DB-only) summary load --
  // matches how /warnings already keeps its own live checks out of /summary.
  if (path === '/api/costs/limits' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const win = monthWindow(now, monthKey)
      const { pricing } = loadPricingConfig()
      const tokenByAgent = getTokenCostByAgent(getDb(), pricing, win.start, win.end, win.fractionElapsed)
      const { config: subsConfig } = loadSubscriptionsConfig()
      const subscriptions = deriveLifecycle(subsConfig, now)
      const limits = await getLimitStatus(getDb(), now, subscriptions)
      json(res, { token_by_agent: tokenByAgent, limits })
    } catch (err) {
      logger.error({ err }, 'CostOps limits failed')
      json(res, { error: 'Cost limits failed' }, 500)
    }
    return true
  }

  // v0.7/v2: deterministic + LIVE-wired warnings. Deterministic rules (budget/
  // sync/lifecycle/pending_permission) are DB-only and instant; the 2 live
  // checks (Render build-minutes, workspace alerts) add a real network round
  // trip (Render) / a stored agent-fed signal (workspace) -- never fabricated,
  // "no_api_or_no_access" surfaces where there genuinely is no data source.
  if (path === '/api/costs/warnings' && method === 'GET') {
    try {
      const monthKey = url.searchParams.get('month') || undefined
      const now = Math.floor(Date.now() / 1000)
      const { config, exists, errors } = loadCostopsConfig()
      const { pricing, exists: pricingExists } = loadPricingConfig()
      const db = getDb()
      syncFixedCostsToLedger(db, config, now, monthKey)
      const summary = getCostSummary(db, config, now, { monthKey, configExists: exists, configErrors: errors, pricing, pricingExists })
      const { config: subsConfig } = loadSubscriptionsConfig()
      const subscriptions = deriveLifecycle(subsConfig, now)
      // Card fa041036: getLimitStatus() and this route's own render/ssl/domain warnings both need
      // the same 3 live checks -- they now share getLiveCheckWarnings()'s TTL-cached result instead
      // of each independently hitting Render's API + doing a TLS handshake per host + an RDAP
      // lookup (previously: once concurrently inside getLimitStatus, then AGAIN sequentially here
      // -- the real cause of the reported 20-35s, not the DB-side ledger reads).
      const limits = await getLimitStatus(db, now, subscriptions)
      const deterministic = getWarnings(db, config, now, summary, subscriptions, limits)
      const workspaceAlerts = buildWorkspaceAlertWarnings(db, now)
      const { config: domainsConfig } = loadDomainsConfig()
      const { renderWarnings: renderBuildMinutes, sslWarnings, domainWarnings } = await getLiveCheckWarnings(now, domainsConfig.ssl_hosts, domainsConfig.domains)
      json(res, { warnings: [...deterministic, ...workspaceAlerts, ...renderBuildMinutes, ...sslWarnings, ...domainWarnings] })
    } catch (err) {
      logger.error({ err }, 'CostOps warnings failed')
      json(res, { error: 'Cost warnings failed' }, 500)
    }
    return true
  }

  // v0.7/v2: agent-side Gmail sweep POSTs a sanitized workspace-alert signal
  // here (payment failure / suspension notice). No raw email content stored.
  if (path === '/api/costs/workspace-alerts' && method === 'POST') {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}') as { entries?: unknown }
      const entries = Array.isArray(body?.entries) ? body.entries : []
      const now = Math.floor(Date.now() / 1000)
      const result = ingestWorkspaceAlerts(getDb(), entries as import('../../costops/workspace-alerts.js').WorkspaceAlertEntry[], now)
      json(res, { ok: result.errors.length === 0, ...result })
    } catch (err) {
      logger.error({ err }, 'CostOps workspace-alerts ingest failed')
      json(res, { ok: false, error: 'workspace-alerts ingest failed' }, 500)
    }
    return true
  }

  // v0.7: sanitized export -- provider/period/amount/confidence/source_type only.
  // No raw email body, no raw invoice ID, no account reference, no PII.
  if (path === '/api/costs/export' && method === 'GET') {
    try {
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
      const month = url.searchParams.get('month') || undefined
      const fromMonth = url.searchParams.get('from') || undefined
      const toMonth = url.searchParams.get('to') || undefined
      const now = Math.floor(Date.now() / 1000)
      const rows = exportCostRows(getDb(), now, { month, fromMonth, toMonth })
      if (format === 'csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store' })
        res.end(rowsToCsv(rows))
      } else {
        json(res, { rows })
      }
    } catch (err) {
      logger.error({ err }, 'CostOps export failed')
      json(res, { error: 'Cost export failed' }, 500)
    }
    return true
  }

  // Phase 1 (GAP-18): normalized export set beyond the ledger CSV/JSON above.
  // Each reuses the exact function the dashboard/summary route itself calls,
  // so export totals match dashboard totals by construction.
  if (path.startsWith('/api/costs/export/') && method === 'GET') {
    const wantCsv = url.searchParams.get('format') === 'csv'
    const month = url.searchParams.get('month') || undefined
    const now = Math.floor(Date.now() / 1000)
    const sendCsvOrJson = (csv: string | null, jsonBody: unknown) => {
      if (wantCsv && csv != null) {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store' })
        res.end(csv)
      } else {
        json(res, jsonBody)
      }
    }
    try {
      const kind = path.slice('/api/costs/export/'.length)
      const { config } = loadCostopsConfig()
      const db = getDb()
      switch (kind) {
        case 'source-inventory': {
          const exp = exportSourceInventory(db, config, now)
          sendCsvOrJson(wantCsv ? sourceInventoryToCsv(exp.sources) : null, exp)
          return true
        }
        case 'provider-summary': {
          const exp = exportProviderSummary(db, config, now, { month })
          sendCsvOrJson(wantCsv ? providerSummaryToCsv(exp.provider_breakdown) : null, exp)
          return true
        }
        case 'category-summary': {
          const exp = exportCategorySummary(db, now, { month })
          sendCsvOrJson(wantCsv ? categorySummaryToCsv(exp.categories) : null, exp)
          return true
        }
        case 'budget-variance': {
          json(res, exportBudgetVariance(db, config, now, { month }))
          return true
        }
        case 'reconciliation': {
          const exp = exportReconciliationReport(db, now, month)
          sendCsvOrJson(wantCsv ? reconciliationReportToCsv(exp.sources) : null, exp)
          return true
        }
        case 'forecast-history': {
          json(res, exportForecastHistory(db, now, { month }))
          return true
        }
        case 'data-quality': {
          json(res, exportDataQualityReport(db, config, now, { month }))
          return true
        }
        case 'monthly-snapshot': {
          json(res, exportMonthlySnapshot(db, config, now, month))
          return true
        }
        case 'alerts': {
          const exp = exportAlerts(db, now, { includeResolved: url.searchParams.get('resolved') === '1' })
          sendCsvOrJson(wantCsv ? alertsToCsv(exp.alerts) : null, exp)
          return true
        }
        default:
          json(res, { error: `unknown export kind '${kind}'` }, 404)
          return true
      }
    } catch (err) {
      logger.error({ err }, 'CostOps normalized export failed')
      json(res, { error: 'Normalized export failed' }, 500)
    }
    return true
  }

  // Card a1552362 (item 3): manual cost/entitlement entry -- the one hand-entry door for a
  // provider Istvan already knows the number for but that has no API/invoice-ingest path yet.
  // POST creates (409 if the key already exists), PATCH updates (404 if it doesn't), DELETE
  // removes (card 73e8914a -- 404 if missing, 409 if the target isn't actually a manual entry,
  // same guard as PATCH) -- see manual-entry.ts for the full rationale.
  if (path === '/api/costs/manual' && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      let fxUsdHuf = 0, fxEurHuf = 0
      try {
        const { loadRenderPricing } = await import('../../costops/collectors/render.js')
        const p = loadRenderPricing().pricing
        fxUsdHuf = p.fx_usd_huf || 0
        fxEurHuf = p.fx_eur_huf || 0
      } catch { /* fx 0 -> non-HUF entries rejected as unconvertible */ }
      const { createManualCost, updateManualCost, deleteManualCost } = await import('../../costops/manual-entry.js')
      const result = method === 'POST'
        ? createManualCost(getDb(), body, { fxUsdHuf, fxEurHuf, now })
        : method === 'PATCH'
        ? updateManualCost(getDb(), body, { fxUsdHuf, fxEurHuf, now })
        : deleteManualCost(getDb(), body, { now })
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps manual cost entry failed')
      json(res, { ok: false, error: 'manual cost entry failed' }, 500)
    }
    return true
  }

  if (path === '/api/costs/entitlements/manual' && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    try {
      const raw = await readBody(ctx.req)
      const body = JSON.parse(raw.toString() || '{}')
      const now = Math.floor(Date.now() / 1000)
      const { createManualEntitlement, updateManualEntitlement, deleteManualEntitlement } = await import('../../costops/manual-entry.js')
      const result = method === 'POST'
        ? createManualEntitlement(getDb(), body, now)
        : method === 'PATCH'
        ? updateManualEntitlement(getDb(), body, now)
        : deleteManualEntitlement(getDb(), body)
      json(res, result, result.ok ? 200 : (result.status || 500))
    } catch (err) {
      logger.error({ err }, 'CostOps manual entitlement entry failed')
      json(res, { ok: false, error: 'manual entitlement entry failed' }, 500)
    }
    return true
  }

  return false
}
