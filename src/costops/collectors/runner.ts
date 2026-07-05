// CostOps v0.3 -- collector runner. Deterministic, no LLM.
//
// Loads a collector's normalized lines, upserts them into cost_line_items as
// confidence='provider_api' (idempotent by dedup_key, NEVER overwriting the
// manual/estimate rows -- they have a different dedup_key), and records an
// import_runs row. On error it DELETES NOTHING and records a sanitized failure.
// Secrets never enter the DB, logs, or the returned result.

import type Database from 'better-sqlite3'
import type { ProviderCollector, CollectOpts, NormalizedCostLine, ImportRunResult, ImportStatus } from './types.js'

/** Redact anything that looks like a key/token before it can reach a log/DB. */
export function sanitizeError(err: unknown): { code: string; message: string } {
  const e = err as { code?: string; name?: string; message?: string; status?: number }
  const code = String(e?.code ?? e?.status ?? e?.name ?? 'error').slice(0, 40)
  let msg = String(e?.message ?? 'collector error').slice(0, 300)
  msg = msg
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/(x-api-key|authorization|bearer)\s*[:=]\s*\S+/gi, '$1 ***')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***')
  return { code, message: msg }
}

function upsertProviderLines(db: Database.Database, lines: NormalizedCostLine[], now: number): number {
  const upsertSource = db.prepare(`
    INSERT INTO cost_sources (id, name, provider, source_type, account_ref, currency, active, created_at, updated_at)
    VALUES (@id, @id, @provider, 'usage', NULL, @currency, 1, @now, @now)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, updated_at=excluded.updated_at
  `)
  const upsertLine = db.prepare(`
    INSERT INTO cost_line_items
      (source_id, charge_period_start, charge_period_end, charge_category, service_name,
       usage_type, consumed_quantity, consumed_unit, billed_cost, effective_cost, currency,
       confidence, data_freshness, source_ref, dedup_key, created_at)
    VALUES
      (@source_id, @start, @end, 'usage', @source_id,
       @usage_type, @quantity, @unit, @amount, NULL, @currency,
       @confidence, @freshness, @source_ref, @dedup_key, @now)
    ON CONFLICT(dedup_key) DO UPDATE SET
      billed_cost=excluded.billed_cost, currency=excluded.currency,
      confidence=excluded.confidence, data_freshness=excluded.data_freshness,
      source_ref=excluded.source_ref, usage_type=excluded.usage_type
  `)
  const tx = db.transaction((ls: NormalizedCostLine[]) => {
    let n = 0
    for (const l of ls) {
      upsertSource.run({ id: l.service, provider: l.provider, currency: l.currency, now })
      upsertLine.run({
        source_id: l.service, start: l.billing_period_start, end: l.billing_period_end,
        usage_type: l.usage_type ?? null, quantity: l.quantity ?? null, unit: l.unit ?? null,
        amount: l.amount, currency: l.currency, confidence: l.confidence,
        freshness: l.data_freshness_at, source_ref: l.raw_ref_hash ?? null, dedup_key: l.dedup_key, now,
      })
      n++
    }
    return n
  })
  return tx(lines)
}

export interface RunCollectorArgs {
  db: Database.Database
  collector: ProviderCollector
  opts: CollectOpts
  now: number
}

/**
 * Run a collector end to end and record an import_runs row. Never throws on a
 * collector error -- it records a sanitized failure and imports nothing. Returns
 * the run result (also secret-free).
 */
export async function runCollector(args: RunCollectorArgs): Promise<ImportRunResult> {
  const { db, collector, opts, now } = args
  const insertRun = db.prepare(`
    INSERT INTO import_runs (provider, collector_name, started_at, finished_at, status,
      period_start, period_end, imported_count, error_code, error_message_sanitized, data_freshness_at)
    VALUES (@provider, @collector, @started, @finished, @status,
      @ps, @pe, @count, @ecode, @emsg, @fresh)
  `)
  let status: ImportStatus = 'ok'
  let importedCount = 0
  let errorCode: string | null = null
  let errorMsg: string | null = null
  let freshness: number | null = null
  try {
    const lines = await collector.collect(opts)
    importedCount = upsertProviderLines(db, lines, now)
    freshness = lines.reduce((m, l) => Math.max(m, l.data_freshness_at), 0) || now
  } catch (err) {
    status = 'error'
    const s = sanitizeError(err)
    errorCode = s.code
    errorMsg = s.message
    // IMPORTANT: delete nothing. Last good data stays.
  }
  insertRun.run({
    provider: collector.provider, collector: collector.collectorName,
    started: now, finished: now, status,
    ps: opts.periodStart, pe: opts.periodEnd, count: importedCount,
    ecode: errorCode, emsg: errorMsg, fresh: freshness,
  })
  return {
    provider: collector.provider, collectorName: collector.collectorName,
    status, importedCount, errorCode, errorMessageSanitized: errorMsg, dataFreshnessAt: freshness,
  }
}
